//go:build linux

package main

import (
	"encoding/binary"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/florianl/go-nfqueue/v2"
	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
	"github.com/ti-mo/netfilter"
	"golang.org/x/sys/unix"
)

func ptr[T any](value T) *T { return &value }

func capturedCT(t *testing.T, tuple flowTuple, id uint32) []byte {
	t.Helper()
	port := func(value uint16) []byte { p := make([]byte, 2); binary.BigEndian.PutUint16(p, value); return p }
	attrs := []netfilter.Attribute{
		{Type: 1, Nested: true, Children: []netfilter.Attribute{
			{Type: 1, Nested: true, Children: []netfilter.Attribute{{Type: 1, Data: tuple.source.Addr().AsSlice()}, {Type: 2, Data: tuple.destination.Addr().AsSlice()}}},
			{Type: 2, Nested: true, Children: []netfilter.Attribute{{Type: 1, Data: []byte{tuple.protocol}}, {Type: 2, Data: port(tuple.source.Port())}, {Type: 3, Data: port(tuple.destination.Port())}}},
		}},
	}
	idAttr := netfilter.Attribute{Type: 12}
	idAttr.PutUint32(id)
	attrs = append(attrs, idAttr)
	message, err := netfilter.MarshalNetlink(netfilter.Header{SubsystemID: netfilter.NFSubsysCTNetlink, Family: netfilter.ProtoIPv4}, attrs)
	if err != nil {
		t.Fatal(err)
	}
	return message.Data[4:]
}

func observation(t *testing.T) (*Interceptor, nfqueue.Attribute, flowTuple) {
	t.Helper()
	packet := dnsPacket(false, false)
	tuple, _ := packetTuple(packet)
	ct := capturedCT(t, tuple, 1234)
	i := &Interceptor{flows: make(map[flowTuple]observedFlow), ifaces: map[int]interfaceState{7: {"tun0", true, 1}}, lookupRoute: func(flowTuple, uint32, uint32, uint8) (int, error) { return 7, nil }, lookupSocket: func(flowTuple) (socketIdentity, error) {
		return socketIdentity{UID: 10001, Cookie: 123, Inode: 456}, nil
	}}
	journal, err := openFlowJournal(filepath.Join(t.TempDir(), "flows"), 1053)
	if err != nil {
		t.Fatal(err)
	}
	i.ownership = journal
	t.Cleanup(func() { journal.close() })
	a := nfqueue.Attribute{PacketID: ptr(uint32(1)), Hook: ptr(uint8(unix.NF_INET_LOCAL_OUT)), UID: ptr(uint32(10001)), GID: ptr(uint32(10001)), OutDev: ptr(uint32(7)), Payload: &packet, Ct: &ct}
	return i, a, tuple
}

func TestCaptureNeedsOriginalContextAndPreservesMark(t *testing.T) {
	i, a, tuple := observation(t)
	mark, ok := i.observe(a)
	if !ok || mark != 0 || i.flows[tuple].context.Mark != 0 {
		t.Fatal("absent NFQA_MARK means zero, not missing context")
	}
	a.Mark = ptr(uint32(0x23456))
	mark, ok = i.observe(a)
	if !ok || mark != 0x23456 || i.flows[tuple].context.Mark != mark {
		t.Fatal("original network mark was lost")
	}
	for _, test := range []struct {
		name string
		edit func(*nfqueue.Attribute)
	}{
		{"no-owner", func(a *nfqueue.Attribute) { a.UID = nil }},
		{"no-group", func(a *nfqueue.Attribute) { a.GID = nil }},
		{"no-interface", func(a *nfqueue.Attribute) { a.OutDev = nil }},
		{"unknown-interface", func(a *nfqueue.Attribute) { a.OutDev = ptr(uint32(55)) }},
		{"no-conntrack", func(a *nfqueue.Attribute) { a.Ct = nil }},
		{"capture-mark-collision", func(a *nfqueue.Attribute) { a.Mark = ptr(captureMark) }},
		{"wrong-hook", func(a *nfqueue.Attribute) { a.Hook = ptr(uint8(unix.NF_INET_PRE_ROUTING)) }},
		{"partial-capture", func(a *nfqueue.Attribute) { a.CapLen = ptr(uint32(999)) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			interceptor, attr, _ := observation(t)
			test.edit(&attr)
			if _, ok := interceptor.observe(attr); ok || len(interceptor.flows) != 0 {
				t.Fatal("unproven context must not authorize redirection")
			}
		})
	}
}

func TestInterfaceRemovalAndReuseInvalidateCapturedFlow(t *testing.T) {
	i, a, tuple := observation(t)
	if _, ok := i.observe(a); !ok {
		t.Fatal("initial capture rejected")
	}
	flow := i.flows[tuple]
	message := netlink.Message{Header: netlink.Header{Type: unix.RTM_DELLINK}, Data: make([]byte, 16)}
	binary.NativeEndian.PutUint32(message.Data[4:8], 7)
	i.applyLinkEvent(message)
	if err := i.validateFlow(tuple, flow.token); err == nil {
		t.Fatal("removed VPN interface must invalidate context")
	}
	i.ifaces[7] = interfaceState{"tun0", true, 3}
	if err := i.validateFlow(tuple, flow.token); err == nil {
		t.Fatal("reused interface name and index must not revive old context")
	}
}

func TestCaptureMarkCollisionStopsModeWithoutChangingForeignMark(t *testing.T) {
	i, attr, _ := observation(t)
	attr.Mark = ptr(captureMark | uint32(0x123))
	verdict, _, change := i.captureDecision(attr)
	if verdict != nfqueue.NfDrop || change || i.Health() == nil {
		t.Fatal("foreign capture bit must fail mode instead of reaching NAT")
	}
	attr.Mark = nil
	verdict, _, change = i.captureDecision(attr)
	if verdict != nfqueue.NfDrop || change {
		t.Fatal("mode remains failed until its rules are removed")
	}
	attr.UID = ptr(uint32(0))
	attr.GID = ptr(helperSocketGID)
	verdict, _, change = i.captureDecision(attr)
	if verdict != nfqueue.NfAccept || change {
		t.Fatal("helper root file-owner exemption must remain intact")
	}
}

func TestLookupRequiresExactConntrackReplyAndObservedID(t *testing.T) {
	i, attr, original := observation(t)
	loopback, err := net.InterfaceByName("lo")
	if err != nil {
		t.Fatal(err)
	}
	i.ifaces = map[int]interfaceState{loopback.Index: {loopback.Name, true, 1}}
	i.lookupRoute = func(flowTuple, uint32, uint32, uint8) (int, error) { return loopback.Index, nil }
	attr.OutDev = ptr(uint32(loopback.Index))
	if _, ok := i.observe(attr); !ok {
		t.Fatal("initial capture rejected")
	}
	ct, err := decodeCapturedConntrack(*attr.Ct, false)
	if err != nil {
		t.Fatal(err)
	}
	local := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1053}
	remote := &net.UDPAddr{IP: net.IP(original.source.Addr().AsSlice()), Port: int(original.source.Port())}
	ct.TupleReply = conntrack.Tuple{
		IP:    conntrack.IPTuple{SourceAddress: netip.MustParseAddr("127.0.0.1"), DestinationAddress: original.source.Addr()},
		Proto: conntrack.ProtoTuple{Protocol: 17, SourcePort: 1053, DestinationPort: original.source.Port()},
	}
	i.lookupConntrack = func(reply flowTuple) (*conntrack.Flow, error) {
		if reply != fromCTTuple(ct.TupleReply) {
			t.Fatalf("lookup did not use complete reply tuple: %+v", reply)
		}
		return ct, nil
	}
	flow, err := i.Lookup("udp", local, remote)
	if err != nil || !flow.Valid() || flow.OriginalDestination != original.destination || flow.UID != 10001 {
		t.Fatalf("exact original network context not returned: %+v / %v", flow, err)
	}
	// A reused tuple with a new kernel connection ID is not the observed flow.
	ct.ID++
	if _, err := i.Lookup("udp", local, remote); err == nil {
		t.Fatal("stale observation authorized a different kernel connection")
	}
	ct.ID--
	i.lookupConntrack = func(flowTuple) (*conntrack.Flow, error) {
		bad := *ct
		bad.TupleReply.Proto.SourcePort++
		return &bad, nil
	}
	if _, err := i.Lookup("udp", local, remote); err == nil {
		t.Fatal("different local listener reply tuple was accepted")
	}
}

func TestChangedEffectiveRouteDoesNotCaptureOrReviveFlow(t *testing.T) {
	i, attr, tuple := observation(t)
	i.lookupRoute = func(got flowTuple, uid, mark uint32, tos uint8) (int, error) {
		if got != tuple || uid != 10001 || mark != 0 || tos != 0 {
			t.Fatalf("route query lost packet context: %+v uid=%d mark=%d tos=%d", got, uid, mark, tos)
		}
		return 9, nil // Another module rerouted after the hook's original outdev.
	}
	verdict, _, changed := i.captureDecision(attr)
	if verdict != nfqueue.NfAccept || changed || len(i.flows) != 0 {
		t.Fatal("changed effective route must leave original packet untouched")
	}
	flow := FlowContext{UID: 10001, OutIfIndex: 7}
	if err := i.validateRoute(tuple, flow); err == nil {
		t.Fatal("changed policy route must invalidate an upstream connection")
	}
}

func TestRouteTimeoutFailsModeButUnreachableRoutePassesOriginal(t *testing.T) {
	for _, test := range []struct {
		name      string
		err       error
		verdict   int
		unhealthy bool
	}{
		{"timeout", os.ErrDeadlineExceeded, nfqueue.NfDrop, true},
		{"uid-unsupported", unix.EOPNOTSUPP, nfqueue.NfDrop, true},
		{"unreachable", unix.ENETUNREACH, nfqueue.NfAccept, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			i, attr, _ := observation(t)
			i.lookupRoute = func(flowTuple, uint32, uint32, uint8) (int, error) { return 0, test.err }
			verdict, _, changed := i.captureDecision(attr)
			if verdict != test.verdict || changed || (i.Health() != nil) != test.unhealthy {
				t.Fatal("incorrect handling of route failure")
			}
		})
	}
}

func TestOnlyHelperUIDAndGroupCombinationBypassesQueue(t *testing.T) {
	for _, pair := range []struct {
		uid, gid uint32
		exempt   bool
	}{
		{0, helperSocketGID, true}, {0, 0, false}, {10001, helperSocketGID, false},
	} {
		i, attr, _ := observation(t)
		attr.UID, attr.GID = ptr(pair.uid), ptr(pair.gid)
		_, _, changed := i.captureDecision(attr)
		if changed == pair.exempt {
			t.Fatalf("wrong helper exemption for UID/GID %+v", pair)
		}
	}
}

func TestAmbiguousAndUnconnectedSocketsKeepOriginalPath(t *testing.T) {
	for _, err := range []error{ErrSocketNotFound, ErrSocketAmbiguous} {
		i, attr, _ := observation(t)
		i.lookupSocket = func(flowTuple) (socketIdentity, error) { return socketIdentity{}, err }
		verdict, _, changed := i.captureDecision(attr)
		if verdict != nfqueue.NfAccept || changed || i.Health() != nil {
			t.Fatal("uncertain socket identity must keep original packet")
		}
	}
}
