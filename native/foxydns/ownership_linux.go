//go:build linux

package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
	"github.com/ti-mo/netfilter"
	"golang.org/x/sys/unix"
)

const maxOwnedFlows = 16384
const maxOwnershipBytes = 8 << 20

type ownershipHeader struct {
	Boot string `json:"boot"`
	Port uint16 `json:"port"`
}
type ownedFlow struct {
	Source      netip.AddrPort `json:"source"`
	Destination netip.AddrPort `json:"destination"`
	Protocol    uint8          `json:"protocol"`
	ID          uint32         `json:"id"`
}

func (f ownedFlow) tuple() flowTuple { return flowTuple{f.Source, f.Destination, f.Protocol} }
func (f ownedFlow) valid() bool {
	return f.ID != 0 && f.Source.IsValid() && f.Destination.IsValid() && f.Source.Port() != 0 &&
		f.Destination.Port() == 53 && f.Source.Addr().BitLen() == f.Destination.Addr().BitLen() &&
		(f.Protocol == 6 || f.Protocol == 17)
}

type flowJournal struct {
	mu    sync.Mutex
	file  *os.File
	owned map[ownedFlow]struct{}
}

func ownershipBoot() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	boot := strings.TrimSpace(string(data))
	if err != nil || len(boot) != 36 {
		return "", errors.New("kernel boot identity unavailable")
	}
	return boot, nil
}
func lockOwnership(path string, create bool) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("ownership journal must be absolute")
	}
	flags := unix.O_RDWR | unix.O_CLOEXEC | unix.O_NOFOLLOW
	if create {
		flags |= unix.O_CREAT
	}
	fd, err := unix.Open(path, flags, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		f.Close()
		return nil, errors.New("unsafe ownership journal")
	}
	var raw unix.Stat_t
	if err = unix.Fstat(fd, &raw); err != nil || int(raw.Uid) != os.Geteuid() {
		f.Close()
		return nil, errors.New("foreign ownership journal")
	}
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func openFlowJournal(path string, port uint16) (*flowJournal, error) {
	f, err := lockOwnership(path, true)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*flowJournal, error) { f.Close(); return nil, err }
	st, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if st.Size() != 0 {
		return fail(errors.New("previous capture ownership requires cleanup"))
	}
	boot, err := ownershipBoot()
	if err != nil {
		return fail(err)
	}
	if err = json.NewEncoder(f).Encode(ownershipHeader{boot, port}); err != nil {
		return fail(err)
	}
	if err = f.Sync(); err != nil {
		return fail(err)
	}
	if err = syncOwnershipDirectory(path); err != nil {
		return fail(err)
	}
	return &flowJournal{file: f, owned: make(map[ownedFlow]struct{})}, nil
}
func (j *flowJournal) contains(tuple flowTuple, id uint32) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, ok := j.owned[ownedFlow{tuple.source, tuple.destination, tuple.protocol, id}]
	return ok
}
func (j *flowJournal) record(tuple flowTuple, id uint32) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	f := ownedFlow{tuple.source, tuple.destination, tuple.protocol, id}
	if !f.valid() {
		return errors.New("missing stable conntrack identity")
	}
	if _, ok := j.owned[f]; ok {
		return nil
	}
	if j.file == nil {
		return errors.New("capture is quiesced")
	}
	if len(j.owned) >= maxOwnedFlows {
		return errors.New("capture ownership capacity reached; reconcile required")
	}
	// Persist before the marked verdict. A killed helper must not orphan DNAT.
	if err := json.NewEncoder(j.file).Encode(f); err != nil {
		return err
	}
	if err := j.file.Sync(); err != nil {
		return err
	}
	j.owned[f] = struct{}{}
	return nil
}
func (j *flowJournal) close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.file == nil {
		return nil
	}
	err := j.file.Close()
	j.file = nil
	return err
}
func readFlowJournal(r io.Reader) (ownershipHeader, []ownedFlow, error) {
	var header ownershipHeader
	scanner := bufio.NewScanner(io.LimitReader(r, maxOwnershipBytes+1))
	scanner.Buffer(make([]byte, 1024), 2048)
	if !scanner.Scan() {
		return header, nil, errors.New("missing ownership header")
	}
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil || len(header.Boot) != 36 || header.Port == 0 {
		return header, nil, errors.New("invalid ownership header")
	}
	var flows []ownedFlow
	for scanner.Scan() {
		var flow ownedFlow
		if err := json.Unmarshal(scanner.Bytes(), &flow); err != nil || !flow.valid() || len(flows) >= maxOwnedFlows {
			return header, nil, errors.New("invalid or oversized ownership journal")
		}
		flows = append(flows, flow)
	}
	return header, flows, scanner.Err()
}
func ownedDNAT(flow *conntrack.Flow, owned ownedFlow, port uint16) bool {
	if flow == nil || flow.ID != owned.ID || !owned.valid() || flow.Zone != 0 || flow.TupleOrig.Zone != 0 || flow.TupleReply.Zone != 0 ||
		!flow.Status.DstNAT() || fromCTTuple(flow.TupleOrig) != owned.tuple() {
		return false
	}
	loopback := netip.MustParseAddr("127.0.0.1")
	if owned.Source.Addr().Is6() {
		loopback = netip.IPv6Loopback()
	}
	return fromCTTuple(flow.TupleReply) == (flowTuple{netip.AddrPortFrom(loopback, port), owned.Source, owned.Protocol})
}
func cleanupJournalFlows(header ownershipHeader, flows []ownedFlow, get func(flowTuple) (*conntrack.Flow, error), remove func(*conntrack.Flow) error) error {
	deadline := time.Now().Add(8 * time.Second)
	for _, owned := range flows {
		if time.Now().After(deadline) {
			return errors.New("owned conntrack cleanup timed out; journal retained")
		}
		loopback := netip.MustParseAddr("127.0.0.1")
		if owned.Source.Addr().Is6() {
			loopback = netip.IPv6Loopback()
		}
		flow, err := get(flowTuple{netip.AddrPortFrom(loopback, header.Port), owned.Source, owned.Protocol})
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return err
		}
		if !ownedDNAT(flow, owned, header.Port) {
			continue
		}
		if err = remove(flow); err != nil && !errors.Is(err, unix.ENOENT) {
			return err
		}
	}
	return nil
}
func cleanupOwnedFlows(path string) error {
	f, err := lockOwnership(path, false)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() == 0 {
		return nil
	}
	if st.Size() > maxOwnershipBytes {
		return errors.New("oversized ownership journal")
	}
	header, flows, err := readFlowJournal(f)
	if err != nil {
		return err
	}
	boot, err := ownershipBoot()
	if err != nil {
		return err
	}
	if header.Boot == boot && len(flows) != 0 {
		lookup, err := newCleanupLookup()
		if err != nil {
			return err
		}
		defer lookup.ct.Close()
		if err = cleanupJournalFlows(header, flows, lookup.getConntrack, func(flow *conntrack.Flow) error {
			return deleteOwnedConntrack(lookup.ct, flow)
		}); err != nil {
			return fmt.Errorf("owned DNAT cleanup: %w", err)
		}
	}
	if err = f.Truncate(0); err != nil {
		return err
	}
	return f.Sync()
}

func newCleanupLookup() (*Interceptor, error) {
	ct, err := netfilter.Dial(nil)
	if err != nil {
		return nil, err
	}
	return &Interceptor{ct: ct}, nil
}

func deleteOwnedRequest(flow *conntrack.Flow) (netlink.Message, error) {
	if flow == nil || flow.ID == 0 || flow.Zone != 0 || flow.TupleOrig.Zone != 0 || flow.TupleReply.Zone != 0 {
		return netlink.Message{}, errors.New("missing exact conntrack delete identity")
	}
	orig, reply := fromCTTuple(flow.TupleOrig), fromCTTuple(flow.TupleReply)
	family := netfilter.ProtoIPv4
	ipSource, ipDestination := uint16(1), uint16(2)
	if orig.source.Addr().Is6() {
		family, ipSource, ipDestination = netfilter.ProtoIPv6, 3, 4
	}
	port := func(p uint16) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, p); return b }
	tuple := func(kind uint16, t flowTuple) netfilter.Attribute {
		return netfilter.Attribute{Type: kind, Nested: true, Children: []netfilter.Attribute{
			{Type: 1, Nested: true, Children: []netfilter.Attribute{{Type: ipSource, Data: t.source.Addr().AsSlice()}, {Type: ipDestination, Data: t.destination.Addr().AsSlice()}}},
			{Type: 2, Nested: true, Children: []netfilter.Attribute{{Type: 1, Data: []byte{t.protocol}}, {Type: 2, Data: port(t.source.Port())}, {Type: 3, Data: port(t.destination.Port())}}},
		}}
	}
	id := make([]byte, 4)
	binary.BigEndian.PutUint32(id, flow.ID)
	// conntrack v0.6.0 Delete omits CTA_ID despite its documentation.
	// Omitting CTA_ZONE selects zero even when CONFIG_NF_CONNTRACK_ZONES is absent.
	return netfilter.MarshalNetlink(netfilter.Header{SubsystemID: netfilter.NFSubsysCTNetlink, MessageType: 2, Family: family, Flags: netlink.Request | netlink.Acknowledge},
		[]netfilter.Attribute{tuple(1, orig), tuple(2, reply), {Type: 12, Data: id}})
}

func deleteOwnedConntrack(ct *netfilter.Conn, flow *conntrack.Flow) error {
	request, err := deleteOwnedRequest(flow)
	if err != nil {
		return err
	}
	if err = ct.SetDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	_, err = ct.Query(request)
	return err
}
