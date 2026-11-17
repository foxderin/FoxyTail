# Exit-node compatibility observation

Exit routing already reports explicit-proxy-only scope, unverified native TUN
coverage, selected-node availability, bridge-policy failures and IPv6 coverage.
The additional `strictReversePath` field is only an observation of IPv4
`rp_filter`; it does not change those verdicts or block selecting an exit node.

For an active exit preference in bridge/native-TUN mode, read
`/proc/sys/net/ipv4/conf/{all,interface}/rp_filter`. Follow the kernel's
`max(all,interface)` rule: 1 is strict, 2 is loose. Ignore the `default` template,
loopback and FoxyTail's own tunnel. `true` means at least one inspected interface
is demonstrably strict, `false` means all inspected values were readable and
none was strict, and `null` means unavailable/incomplete or not applicable.
A demonstrated strict interface remains a true observation even if a different
interface cannot be read. Interface presence does not prove it carries the current
flow, so the UI says only that asymmetric routing may be restricted, not that a
connection has failed. No sysctl, firewall, route or preference is modified.

The observation is read within the existing account/preference/configuration
snapshot fence. It is not cached across reads and does not spawn a new monitor.
Unknown/missing observations do not display a misleading compatibility success.
The short explanatory text appears only with a known selected exit in bridge or
native-TUN mode; proxy mode has different coverage and retains its existing hint.

References:
- Linux semantics: https://docs.kernel.org/networking/ip-sysctl.html#rp-filter-integer
- Inspiration: Shellscaled `helper/main.go`, `strictReversePath`, pinned at
  `11af7c142d55c726f3ca9ca7a6d93ecd45be066e`. FoxyTail deliberately does not copy
  its selection-blocking policy or silently enable netfilter.

Host regression exercises strict/loose precedence, ignored interfaces,
missing/malformed values, partial observations, non-applicable modes, unchanged
kernel fixture bytes and unchanged exit verdicts. The existing exit UI scenario
checks hint visibility and absence of mutations. Real Android packet delivery is
not inferred from these tests.
