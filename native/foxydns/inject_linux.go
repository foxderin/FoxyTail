//go:build linux

package main

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"golang.org/x/sys/unix"
)

// injectUDP delivers a forged DNS answer as if the original resolver sent it.
// The packet is locally generated (sport=53, dport=client): it traverses the
// output path, routes to the client's own address and lands on its pending
// socket, while never matching the hijack queue's --dport 53 rule again.
// This is the only mechanism needed because the kernel itself delivers the
// packet; no connection state, mark or destination rewriting is involved.
func injectUDP(src, dst netip.AddrPort, payload []byte) error {
	if !src.IsValid() || !dst.IsValid() || src.Port() == 0 || dst.Port() == 0 ||
		src.Addr().Is4() != dst.Addr().Is4() || src.Addr().Is4In6() != dst.Addr().Is4In6() ||
		len(payload) == 0 || len(payload) > 0xffff-8 {
		return errors.New("invalid injection endpoints")
	}
	if src.Addr().Is4() || src.Addr().Is4In6() {
		return injectUDP4(src, dst, payload)
	}
	return injectUDP6(src, dst, payload)
}

// udp4Packet builds a complete IPv4+UDP packet. The ID and header checksum
// are left zero; the kernel fills both because IPPROTO_RAW implies HDRINCL.
func udp4Packet(src, dst netip.AddrPort, payload []byte) []byte {
	packet := make([]byte, 20+8+len(payload))
	packet[0] = 0x45
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	packet[8], packet[9] = 64, 17
	copy(packet[12:16], src.Addr().Unmap().AsSlice())
	copy(packet[16:20], dst.Addr().Unmap().AsSlice())
	udp := packet[20:]
	binary.BigEndian.PutUint16(udp[0:2], src.Port())
	binary.BigEndian.PutUint16(udp[2:4], dst.Port())
	binary.BigEndian.PutUint16(udp[4:6], uint16(8+len(payload)))
	copy(udp[8:], payload)
	binary.BigEndian.PutUint16(udp[6:8], udpChecksum4(src.Addr().Unmap(), dst.Addr().Unmap(), udp))
	return packet
}

func udp6Packet(src, dst netip.AddrPort, payload []byte) []byte {
	packet := make([]byte, 40+8+len(payload))
	packet[0] = 0x60
	binary.BigEndian.PutUint16(packet[4:6], uint16(8+len(payload)))
	packet[6], packet[7] = 17, 64
	copy(packet[8:24], src.Addr().AsSlice())
	copy(packet[24:40], dst.Addr().AsSlice())
	udp := packet[40:]
	binary.BigEndian.PutUint16(udp[0:2], src.Port())
	binary.BigEndian.PutUint16(udp[2:4], dst.Port())
	binary.BigEndian.PutUint16(udp[4:6], uint16(8+len(payload)))
	copy(udp[8:], payload)
	binary.BigEndian.PutUint16(udp[6:8], udpChecksum6(src.Addr(), dst.Addr(), udp))
	return packet
}

func injectUDP4(src, dst netip.AddrPort, payload []byte) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_RAW, unix.IPPROTO_RAW)
	if err != nil {
		return fmt.Errorf("raw IPv4 socket: %w", err)
	}
	defer unix.Close(fd)
	var remote unix.SockaddrInet4
	copy(remote.Addr[:], dst.Addr().Unmap().AsSlice())
	return unix.Sendto(fd, udp4Packet(src, dst, payload), 0, &remote)
}

func injectUDP6(src, dst netip.AddrPort, payload []byte) error {
	fd, err := unix.Socket(unix.AF_INET6, unix.SOCK_RAW, unix.IPPROTO_RAW)
	if err != nil {
		return fmt.Errorf("raw IPv6 socket: %w", err)
	}
	defer unix.Close(fd)
	if err = unix.SetsockoptInt(fd, unix.IPPROTO_IPV6, unix.IPV6_HDRINCL, 1); err != nil {
		return fmt.Errorf("IPv6 header option: %w", err)
	}
	var remote unix.SockaddrInet6
	copy(remote.Addr[:], dst.Addr().AsSlice())
	return unix.Sendto(fd, udp6Packet(src, dst, payload), 0, &remote)
}

func checksumSum(parts ...[]byte) uint16 {
	var sum uint32
	var odd bool
	var high byte
	for _, part := range parts {
		for _, b := range part {
			if odd {
				sum += uint32(high)<<8 | uint32(b)
				odd = false
			} else {
				high, odd = b, true
			}
		}
	}
	if odd {
		sum += uint32(high) << 8
	}
	for sum > 0xffff {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

func udpChecksum4(src, dst netip.Addr, udp []byte) uint16 {
	pseudo := make([]byte, 12)
	copy(pseudo[0:4], src.AsSlice())
	copy(pseudo[4:8], dst.AsSlice())
	pseudo[9] = 17
	binary.BigEndian.PutUint16(pseudo[10:12], uint16(len(udp)))
	out := checksumSum(pseudo, udp)
	if out == 0 {
		out = 0xffff
	}
	return out
}

func udpChecksum6(src, dst netip.Addr, udp []byte) uint16 {
	pseudo := make([]byte, 40)
	copy(pseudo[0:16], src.AsSlice())
	copy(pseudo[16:32], dst.AsSlice())
	binary.BigEndian.PutUint32(pseudo[32:36], uint32(len(udp)))
	pseudo[39] = 17
	out := checksumSum(pseudo, udp)
	if out == 0 {
		out = 0xffff
	}
	return out
}

// injectSelfTest proves that forged-source packets reach a bound socket on
// this device: raw socket creation may succeed while SELinux, iptables REJECT
// or rp_filter silently drops the packet before delivery. A real round trip
// is the only conclusive check.
func injectSelfTest() error {
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return fmt.Errorf("probe listener: %w", err)
	}
	defer listener.Close()
	port := listener.LocalAddr().(*net.UDPAddr).Port
	token := []byte(rand.Text())
	target := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port))
	source := netip.MustParseAddrPort("192.0.2.53:53")
	buffer := make([]byte, 512)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err = injectUDP(source, target, token); err != nil {
			return err
		}
		_ = listener.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
		n, from, err := listener.ReadFromUDP(buffer)
		if err == nil && n == len(token) && string(buffer[:n]) == string(token) && from.Port == 53 {
			return nil
		}
	}
	return errors.New("forged-source answer was not delivered")
}

// ProbeHijackCapabilities checks the two kernel dependencies of the hijack
// mode independently of the transparent path: a metadata-light NFQUEUE
// binding (no conntrack) and answer injection.
func ProbeHijackCapabilities(queue uint16) error {
	selector, err := NewSelector(queue, nil)
	if err != nil {
		return err
	}
	_ = selector.Close()
	return injectSelfTest()
}
