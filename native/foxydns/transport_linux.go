//go:build linux

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/florianl/go-nfqueue/v2"
	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
	"github.com/ti-mo/netfilter"
	"golang.org/x/sys/unix"
)

const (
	flowLifetime = 2 * time.Minute
	maxFlows     = 4096
)

type interfaceState struct {
	name       string
	up         bool
	generation uint64
}

type observedFlow struct {
	context FlowContext
	ctID    uint32
	last    time.Time
	token   uint64
}

// Interceptor owns only its NFQUEUE and read-only conntrack/link sockets. It
// never changes iptables, connmarks, routes, interfaces, or another queue.
type Interceptor struct {
	queue           *nfqueue.Nfqueue
	ct              *netfilter.Conn
	links           *netlink.Conn
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	ctMu            sync.Mutex
	lookupConntrack func(flowTuple) (*conntrack.Flow, error)
	lookupRoute     func(flowTuple, uint32, uint32, uint8) (int, error)
	lookupSocket    func(flowTuple) (socketIdentity, error)
	mu              sync.Mutex
	closed          bool
	err             error
	serial          uint64
	flows           map[flowTuple]observedFlow
	ifaces          map[int]interfaceState
}

func NewInterceptor(queue uint16) (*Interceptor, error) {
	if queue == 0 {
		return nil, errors.New("NFQUEUE number must be nonzero")
	}
	ctx, cancel := context.WithCancel(context.Background())
	i := &Interceptor{cancel: cancel, flows: make(map[flowTuple]observedFlow), ifaces: make(map[int]interfaceState)}
	fail := func(err error) (*Interceptor, error) { _ = i.Close(); return nil, err }
	var err error
	i.ct, err = netfilter.Dial(nil)
	if err != nil {
		return fail(fmt.Errorf("conntrack socket: %w", err))
	}
	// ENOENT proves the kernel actually implements CT_GET. Merely opening a
	// NETLINK_NETFILTER socket would succeed even without conntrack support.
	probe := flowTuple{netip.MustParseAddrPort("127.0.0.1:9"), netip.MustParseAddrPort("127.0.0.1:9"), 17}
	if _, err = i.getConntrack(probe); err != nil && !errors.Is(err, unix.ENOENT) {
		return fail(fmt.Errorf("conntrack query capability: %w", err))
	}
	if err = probeRouteContext(); err != nil {
		return fail(err)
	}
	if err = probeHelperSocketContext(); err != nil {
		return fail(err)
	}
	// Subscribe before taking the initial snapshot, so interface removal and
	// index reuse cannot disappear between a snapshot and subscription.
	i.links, err = netlink.Dial(unix.NETLINK_ROUTE, &netlink.Config{Groups: unix.RTMGRP_LINK | unix.RTMGRP_IPV4_IFADDR | unix.RTMGRP_IPV6_IFADDR})
	if err != nil {
		return fail(fmt.Errorf("interface change subscription: %w", err))
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return fail(fmt.Errorf("interface snapshot: %w", err))
	}
	for _, iface := range interfaces {
		i.ifaces[iface.Index] = interfaceState{iface.Name, iface.Flags&net.FlagUp != 0, 1}
	}
	i.wg.Add(1)
	go i.watchLinks()
	i.queue, err = nfqueue.Open(&nfqueue.Config{
		NfQueue: queue, MaxQueueLen: 512, MaxPacketLen: 65535,
		Copymode: nfqueue.NfQnlCopyPacket, AfFamily: unix.AF_UNSPEC,
		Flags:        nfqueue.NfQaCfgFlagFailOpen | nfqueue.NfQaCfgFlagUIDGid | nfqueue.NfQaCfgFlagConntrack,
		WriteTimeout: time.Second,
	})
	if err != nil {
		return fail(fmt.Errorf("NFQUEUE socket: %w", err))
	}
	if err = i.queue.Con.SetReadBuffer(4 << 20); err != nil {
		return fail(fmt.Errorf("NFQUEUE receive buffer: %w", err))
	}
	// Only registration/binding confirms the kernel queue and requested flags.
	if err = i.queue.RegisterWithErrorFunc(ctx, i.capture, func(err error) int {
		i.setError(fmt.Errorf("NFQUEUE receive: %w", err))
		return 1
	}); err != nil {
		return fail(queueRegistrationError(err))
	}
	return i, nil
}

func queueRegistrationError(err error) error {
	// go-nfqueue wraps failures from family/queue binding, but returns the
	// configuration ACK error directly. For our known flags (FAIL_OPEN,
	// UID_GID, CONNTRACK), Linux rejects CONNTRACK with EOPNOTSUPP when the
	// NFQUEUE/conntrack glue hook is absent. Copy parameters cannot produce
	// that kernel error. Do not unwrap binding failures or syscall errors into
	// this diagnosis: they do not prove the metadata capability is missing.
	if ack, direct := err.(*netlink.OpError); direct && ack.Op == "receive" && ack.Err == unix.EOPNOTSUPP {
		return fmt.Errorf("NFQUEUE kernel does not support required conntrack queue metadata (CONFIG_NETFILTER_NETLINK_GLUE_CT): %w", err)
	}
	return fmt.Errorf("NFQUEUE bind/metadata flags: %w", err)
}

func ProbeCapabilities(queue uint16) error {
	i, err := NewInterceptor(queue)
	if err != nil {
		return err
	}
	return i.Close()
}

func (i *Interceptor) setError(err error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !i.closed && i.err == nil {
		i.err = err
	}
}

func (i *Interceptor) Health() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.closed {
		return errors.New("DNS interceptor is closed")
	}
	return i.err
}

func (i *Interceptor) Close() error {
	i.mu.Lock()
	if i.closed {
		i.mu.Unlock()
		return nil
	}
	i.closed = true
	i.mu.Unlock()
	i.cancel()
	var errs []error
	if i.queue != nil {
		errs = append(errs, i.queue.Close())
	}
	if i.links != nil {
		errs = append(errs, i.links.Close())
	}
	i.wg.Wait()
	if i.ct != nil {
		errs = append(errs, i.ct.Close())
	}
	return errors.Join(errs...)
}

func (i *Interceptor) watchLinks() {
	defer i.wg.Done()
	for {
		messages, err := i.links.Receive()
		if err != nil {
			i.setError(fmt.Errorf("interface change monitor: %w", err))
			return
		}
		for _, message := range messages {
			i.applyLinkEvent(message)
		}
	}
}

func (i *Interceptor) applyLinkEvent(message netlink.Message) {
	var index int
	var name string
	var up, deleted bool
	switch message.Header.Type {
	case unix.RTM_NEWLINK, unix.RTM_DELLINK:
		if len(message.Data) < 16 {
			i.setError(errors.New("truncated interface change event"))
			return
		}
		index = int(int32(binary.NativeEndian.Uint32(message.Data[4:8])))
		up = binary.NativeEndian.Uint32(message.Data[8:12])&unix.IFF_UP != 0
		deleted = message.Header.Type == unix.RTM_DELLINK
		attrs, err := netlink.UnmarshalAttributes(message.Data[16:])
		if err != nil {
			i.setError(fmt.Errorf("interface event attributes: %w", err))
			return
		}
		for _, attr := range attrs {
			if attr.Type == unix.IFLA_IFNAME {
				name = strings.TrimRight(string(attr.Data), "\x00")
			}
		}
	case unix.RTM_NEWADDR, unix.RTM_DELADDR:
		if len(message.Data) < 8 {
			i.setError(errors.New("truncated interface address event"))
			return
		}
		index = int(binary.NativeEndian.Uint32(message.Data[4:8]))
	default:
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	previous := i.ifaces[index]
	previous.generation++
	if deleted {
		previous.name, previous.up = "", false
	} else if name != "" {
		previous.name, previous.up = name, up
	}
	i.ifaces[index] = previous
}

func (i *Interceptor) capture(a nfqueue.Attribute) int {
	if a.PacketID == nil {
		i.setError(errors.New("NFQUEUE packet missing verdict ID"))
		return 1
	}
	verdict, mark, changed := i.captureDecision(a)
	var err error
	if changed {
		err = i.queue.SetVerdictWithOption(*a.PacketID, verdict, nfqueue.WithMark(mark))
	} else {
		err = i.queue.SetVerdict(*a.PacketID, verdict)
	}
	if err != nil {
		i.setError(fmt.Errorf("NFQUEUE verdict: %w", err))
		return 1
	}
	return 0
}

func (i *Interceptor) captureDecision(a nfqueue.Attribute) (int, uint32, bool) {
	// Only our isolated upstream socket credentials bypass capture. Ordinary
	// root/netd sockets need INET_DIAG to recover their actual routing UID.
	if a.UID != nil && *a.UID == 0 && a.GID != nil && *a.GID == helperSocketGID {
		return nfqueue.NfAccept, 0, false
	}
	if a.Mark != nil && *a.Mark&captureMark != 0 {
		// ACCEPT would let NAT mistake somebody else's mark for our capture.
		// Stop this mode until its chains are removed; never clear their mark.
		i.setError(errors.New("reserved DNS capture mark is already in use"))
	}
	if i.Health() != nil {
		return nfqueue.NfDrop, 0, false
	}
	mark, captured := i.observe(a)
	if i.Health() != nil {
		return nfqueue.NfDrop, 0, false
	}
	if captured {
		return nfqueue.NfAccept, mark | captureMark, true
	}
	// Unsupported/untracked packets retain their original payload and path.
	return nfqueue.NfAccept, 0, false
}

func (i *Interceptor) observe(a nfqueue.Attribute) (uint32, bool) {
	if a.UID == nil || a.GID == nil || a.OutDev == nil || *a.OutDev == 0 ||
		a.Hook == nil || *a.Hook != unix.NF_INET_LOCAL_OUT || a.Payload == nil || a.Ct == nil {
		return 0, false
	}
	var mark uint32
	if a.Mark != nil {
		mark = *a.Mark
	}
	if mark&captureMark != 0 {
		return mark, false
	}
	if a.CapLen != nil && int(*a.CapLen) > len(*a.Payload) {
		return mark, false
	}
	tuple, ok := packetTuple(*a.Payload)
	if !ok {
		return mark, false
	}
	// Only zone zero is supported: otherwise a reply tuple needs a zone that
	// the receiving socket does not expose. Passing it unchanged is safe.
	ct, err := decodeCapturedConntrack(*a.Ct, tuple.source.Addr().Is6())
	if err != nil || ct.Zone != 0 || ct.TupleOrig.Zone != 0 || ct.TupleReply.Zone != 0 ||
		fromCTTuple(ct.TupleOrig) != tuple {
		return mark, false
	}
	socketLookup := i.lookupSocket
	if socketLookup == nil {
		socketLookup = connectedSocket
	}
	identity, identityErr := socketLookup(tuple)
	if socketDiagCapabilityFailure(identityErr) {
		i.setError(fmt.Errorf("socket identity capability lost: %w", identityErr))
	}
	if identityErr != nil {
		return mark, false
	}
	tos := (*a.Payload)[1]
	if tuple.source.Addr().Is6() {
		tos = ((*a.Payload)[0]&15)<<4 | (*a.Payload)[1]>>4
	}
	route := i.lookupRoute
	if route == nil {
		route = effectiveRoute
	}
	out, routeErr := route(tuple, identity.UID, mark, tos)
	if routeCapabilityFailure(routeErr) {
		i.setError(fmt.Errorf("route-query capability lost: %w", routeErr))
	}
	if routeErr != nil || out != int(*a.OutDev) {
		return mark, false
	}
	now := time.Now()
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.closed || i.err != nil {
		return mark, false
	}
	iface, ok := i.ifaces[int(*a.OutDev)]
	if !ok || !iface.up || iface.name == "" {
		return mark, false
	}
	for key, flow := range i.flows {
		if now.Sub(flow.last) > flowLifetime {
			delete(i.flows, key)
		}
	}
	flow, exists := i.flows[tuple]
	if !exists && len(i.flows) >= maxFlows {
		return mark, false
	}
	if !exists || flow.context.UID != identity.UID || flow.context.socketCookie != identity.Cookie || flow.context.socketInode != identity.Inode || flow.context.Mark != mark || flow.context.tos != tos || flow.ctID != ct.ID ||
		flow.context.OutIfIndex != int(*a.OutDev) || flow.context.generation != iface.generation {
		i.serial++
		flow = observedFlow{context: FlowContext{
			OriginalSource: tuple.source, OriginalDestination: tuple.destination, UID: identity.UID, Mark: mark,
			OutIfIndex: int(*a.OutDev), InterfaceName: iface.name, CapturedAt: now,
			protocol: tuple.protocol, tos: tos, generation: iface.generation, socketCookie: identity.Cookie, socketInode: identity.Inode,
		}, ctID: ct.ID, token: i.serial}
	}
	flow.last = now
	i.flows[tuple] = flow
	return mark, true
}

func decodeCapturedConntrack(data []byte, ipv6 bool) (*conntrack.Flow, error) {
	family := byte(unix.AF_INET)
	if ipv6 {
		family = unix.AF_INET6
	}
	var event conntrack.Event
	err := event.Unmarshal(netlink.Message{Header: netlink.Header{Type: 1 << 8}, Data: append([]byte{family, 0, 0, 0}, data...)})
	if err != nil || event.Flow == nil {
		return nil, errors.New("NFQUEUE conntrack metadata unavailable")
	}
	return event.Flow, nil
}

func fromCTTuple(t conntrack.Tuple) flowTuple {
	return flowTuple{
		netip.AddrPortFrom(t.IP.SourceAddress.Unmap(), t.Proto.SourcePort),
		netip.AddrPortFrom(t.IP.DestinationAddress.Unmap(), t.Proto.DestinationPort), t.Proto.Protocol,
	}
}

func (i *Interceptor) Lookup(network string, local, remote net.Addr) (FlowContext, error) {
	if err := i.Health(); err != nil {
		return FlowContext{}, err
	}
	protocol, err := networkProtocol(network)
	if err != nil {
		return FlowContext{}, err
	}
	localAP, err := addressPort(local)
	if err != nil {
		return FlowContext{}, err
	}
	remoteAP, err := addressPort(remote)
	if err != nil {
		return FlowContext{}, err
	}
	if !localAP.Addr().IsLoopback() || localAP.Addr().BitLen() != remoteAP.Addr().BitLen() {
		return FlowContext{}, fmt.Errorf("%w: invalid redirected endpoints", ErrFlowContext)
	}
	// The exact NAT reply tuple identifies the original destination even when
	// one client reuses its source port with several independent DNS servers.
	reply := flowTuple{localAP, remoteAP, protocol}
	fetch := i.lookupConntrack
	if fetch == nil {
		fetch = i.getConntrack
	}
	ct, err := fetch(reply)
	if err != nil {
		if !errors.Is(err, unix.ENOENT) {
			i.setError(fmt.Errorf("conntrack-query capability lost: %w", err))
		}
		return FlowContext{}, fmt.Errorf("%w: conntrack reply lookup: %w", ErrFlowContext, err)
	}
	if ct.Zone != 0 || fromCTTuple(ct.TupleReply) != reply {
		return FlowContext{}, fmt.Errorf("%w: conntrack reply mismatch", ErrFlowContext)
	}
	original := fromCTTuple(ct.TupleOrig)
	i.mu.Lock()
	flow, ok := i.flows[original]
	i.mu.Unlock()
	if !ok || flow.ctID != ct.ID {
		return FlowContext{}, fmt.Errorf("%w: original flow was not observed", ErrFlowContext)
	}
	out := flow.context
	out.validate = func() error { return i.validateFlow(original, flow.token) }
	out.checkSource = func(source netip.AddrPort) error {
		if source.Addr().Unmap() != original.source.Addr().Unmap() {
			return ErrFlowContext
		}
		actual := original
		actual.source = source
		return i.validateRoute(actual, flow.context)
	}
	if err := out.check(); err != nil {
		return FlowContext{}, err
	}
	return out, nil
}

func (i *Interceptor) validateFlow(tuple flowTuple, token uint64) error {
	i.mu.Lock()
	if i.closed || i.err != nil {
		i.mu.Unlock()
		return fmt.Errorf("%w: interceptor unavailable", ErrFlowContext)
	}
	flow, ok := i.flows[tuple]
	iface, found := i.ifaces[flow.context.OutIfIndex]
	if !ok || flow.token != token || time.Since(flow.last) > flowLifetime || !found || !iface.up ||
		iface.generation != flow.context.generation || iface.name != flow.context.InterfaceName {
		i.mu.Unlock()
		return fmt.Errorf("%w: interface or flow expired", ErrFlowContext)
	}
	i.mu.Unlock()
	current, err := net.InterfaceByIndex(flow.context.OutIfIndex)
	if err != nil || current.Name != flow.context.InterfaceName || current.Flags&net.FlagUp == 0 {
		return fmt.Errorf("%w: original interface no longer available", ErrFlowContext)
	}
	socketLookup := i.lookupSocket
	if socketLookup == nil {
		socketLookup = connectedSocket
	}
	identity, err := socketLookup(tuple)
	if socketDiagCapabilityFailure(err) {
		i.setError(fmt.Errorf("socket identity capability lost: %w", err))
	}
	if err != nil || identity.Cookie != flow.context.socketCookie || identity.Inode != flow.context.socketInode || identity.UID != flow.context.UID {
		return fmt.Errorf("%w: original socket changed", ErrFlowContext)
	}
	return i.validateRoute(tuple, flow.context)
}

func (i *Interceptor) validateRoute(tuple flowTuple, flow FlowContext) error {
	route := i.lookupRoute
	if route == nil {
		route = effectiveRoute
	}
	out, err := route(tuple, flow.UID, flow.Mark, flow.tos)
	if routeCapabilityFailure(err) {
		i.setError(fmt.Errorf("route-query capability lost: %w", err))
	}
	if err != nil || out != flow.OutIfIndex {
		return fmt.Errorf("%w: original route changed or cannot be verified", ErrFlowContext)
	}
	return nil
}

func (i *Interceptor) getConntrack(reply flowTuple) (*conntrack.Flow, error) {
	family := netfilter.ProtoIPv4
	sourceType, destinationType := uint16(1), uint16(2)
	if reply.source.Addr().Is6() {
		family, sourceType, destinationType = netfilter.ProtoIPv6, 3, 4
	}
	port := func(value uint16) []byte { out := make([]byte, 2); binary.BigEndian.PutUint16(out, value); return out }
	// Linux uapi nfnetlink_conntrack.h: CTA_TUPLE_REPLY=2, its nested IP=1
	// and PROTO=2; protocol NUM=1, source port=2, destination port=3.
	request, err := netfilter.MarshalNetlink(netfilter.Header{
		SubsystemID: netfilter.NFSubsysCTNetlink, MessageType: 1, Family: family,
		Flags: netlink.Request | netlink.Acknowledge,
	}, []netfilter.Attribute{{Type: 2, Nested: true, Children: []netfilter.Attribute{
		{Type: 1, Nested: true, Children: []netfilter.Attribute{
			{Type: sourceType, Data: reply.source.Addr().AsSlice()}, {Type: destinationType, Data: reply.destination.Addr().AsSlice()},
		}},
		{Type: 2, Nested: true, Children: []netfilter.Attribute{
			{Type: 1, Data: []byte{reply.protocol}}, {Type: 2, Data: port(reply.source.Port())}, {Type: 3, Data: port(reply.destination.Port())},
		}},
	}}})
	if err != nil {
		return nil, err
	}
	i.ctMu.Lock()
	defer i.ctMu.Unlock()
	if err = i.ct.SetDeadline(time.Now().Add(time.Second)); err != nil {
		return nil, err
	}
	messages, err := i.ct.Query(request)
	if err != nil {
		return nil, err
	}
	return decodeConntrackReply(messages)
}

func decodeConntrackReply(messages []netlink.Message) (*conntrack.Flow, error) {
	// CT_GET marks the flow multipart and terminates the response with the
	// requested success ACK. netfilter.Query validates that ACK but retains it
	// in the returned messages; it is not a second conntrack flow.
	if len(messages) < 1 || len(messages) > 2 || messages[0].Header.Type != 1<<8 {
		return nil, errors.New("conntrack reply must contain exactly one flow")
	}
	if len(messages) == 2 {
		ack := messages[1]
		if ack.Header.Type != netlink.Error || len(ack.Data) < 4 || binary.NativeEndian.Uint32(ack.Data[:4]) != 0 {
			return nil, errors.New("conntrack reply contains an invalid acknowledgement")
		}
	}
	var event conntrack.Event
	if err := event.Unmarshal(messages[0]); err != nil {
		return nil, err
	}
	if event.Flow == nil {
		return nil, errors.New("conntrack reply has no flow")
	}
	return event.Flow, nil
}

// DialOriginal never resolves a hostname or consults a default DNS server. The
// socket is tied to the captured UID, mark, source address and interface before
// connect. A missing capability/path is an error, never a fallback to root's
// default route.
func DialOriginal(ctx context.Context, network string, flow FlowContext) (net.Conn, error) {
	protocol, err := networkProtocol(network)
	if err != nil || protocol != flow.protocol {
		return nil, fmt.Errorf("%w: upstream protocol differs from original query", ErrFlowContext)
	}
	if err = flow.check(); err != nil {
		return nil, err
	}
	family := "4"
	if flow.OriginalDestination.Addr().Is6() {
		family = "6"
	}
	base := "udp"
	var local net.Addr = net.UDPAddrFromAddrPort(netip.AddrPortFrom(flow.OriginalSource.Addr(), 0))
	if protocol == 6 {
		base = "tcp"
		local = net.TCPAddrFromAddrPort(netip.AddrPortFrom(flow.OriginalSource.Addr(), 0))
	}
	dialer := net.Dialer{Timeout: 5 * time.Second, LocalAddr: local,
		ControlContext: func(_ context.Context, _, _ string, raw syscall.RawConn) error {
			if err := flow.check(); err != nil {
				return err
			}
			var socketErr error
			if err := raw.Control(func(fd uintptr) {
				socketErr = setSocketContext(int(fd), flow.UID, flow.Mark, flow.InterfaceName)
				if socketErr == nil && flow.tos != 0 {
					if family == "4" {
						socketErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_TOS, int(flow.tos))
					} else {
						socketErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IPV6, unix.IPV6_TCLASS, int(flow.tos))
					}
				}
			}); err != nil {
				return err
			}
			return socketErr
		},
	}
	destination := flow.OriginalDestination
	if destination.Addr().IsLinkLocalUnicast() {
		destination = netip.AddrPortFrom(destination.Addr().WithZone(flow.InterfaceName), destination.Port())
	}
	connection, err := dialHelperSocket(ctx, dialer, base+family, destination.String())
	if err != nil {
		return nil, fmt.Errorf("original DNS path: %w", err)
	}
	if err = flow.check(); err != nil {
		_ = connection.Close()
		return nil, err
	}
	localAP, err := addressPort(connection.LocalAddr())
	if err != nil || flow.checkSource == nil {
		_ = connection.Close()
		return nil, fmt.Errorf("%w: upstream source context unavailable", ErrFlowContext)
	}
	if err = flow.checkSource(localAP); err != nil {
		_ = connection.Close()
		return nil, err
	}
	wrapped := &originalConnection{Conn: connection, flow: flow, source: localAP}
	if protocol == 17 {
		return &originalPacketConnection{originalConnection: wrapped}, nil
	}
	return wrapped, nil
}

type originalConnection struct {
	net.Conn
	flow   FlowContext
	source netip.AddrPort
}

func (c *originalConnection) Write(data []byte) (int, error) {
	if err := c.flow.check(); err != nil {
		return 0, err
	}
	if err := c.flow.checkSource(c.source); err != nil {
		return 0, err
	}
	return c.Conn.Write(data)
}

// Preserve net.PacketConn identity so DNS libraries retain UDP framing.
type originalPacketConnection struct{ *originalConnection }

func (c *originalPacketConnection) ReadFrom(data []byte) (int, net.Addr, error) {
	n, err := c.Read(data)
	return n, c.RemoteAddr(), err
}

func (c *originalPacketConnection) WriteTo(data []byte, destination net.Addr) (int, error) {
	if destination == nil || destination.Network() != c.RemoteAddr().Network() || destination.String() != c.RemoteAddr().String() {
		return 0, errors.New("original DNS socket cannot change destination")
	}
	return c.Write(data)
}

func setSocketContext(fd int, uid, mark uint32, device string) error {
	// sockfs_setattr updates sk_uid, used by Android's uidrange VPN rules.
	// File credentials stay UID 0 / private GID 65533, retaining the narrow
	// helper exemption without excluding root netd or consuming another mark.
	if err := unix.Fchown(fd, int(uid), -1); err != nil {
		return fmt.Errorf("restore socket UID: %w", err)
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Uid != uid {
		return errors.New("socket UID could not be verified")
	}
	if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_MARK, int(mark)); err != nil {
		return fmt.Errorf("restore socket mark: %w", err)
	}
	if actual, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_MARK); err != nil || uint32(actual) != mark {
		return errors.New("socket mark could not be verified")
	}
	if err := unix.SetsockoptString(fd, unix.SOL_SOCKET, unix.SO_BINDTODEVICE, device); err != nil {
		return fmt.Errorf("bind original interface: %w", err)
	}
	if actual, err := unix.GetsockoptString(fd, unix.SOL_SOCKET, unix.SO_BINDTODEVICE); err != nil || strings.TrimRight(actual, "\x00") != device {
		return errors.New("socket interface could not be verified")
	}
	return nil
}
