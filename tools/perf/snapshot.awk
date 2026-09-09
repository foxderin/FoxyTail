# One awk scan per sample; inspect cmdline only in pipes, never emit its contents.
# Android: awk or BusyBox awk. Host fixtures exercise the same parser.
function line(path,    value, ok) {
  ok = (getline value < path)
  close(path)
  return ok > 0 ? value : ""
}
function stat(path, out,    value) {
  value = line(path)
  # comm may itself contain spaces and parentheses; fields follow the last ') '.
  sub(/^.*\) /, "", value)
  return split(value, out, " ") >= 22
}
function metric(path, key,    value, fields, result) {
  result = "missing"
  while ((getline value < path) > 0) {
    split(value, fields, /[ \t]+/)
    if (fields[1] == key && fields[2] ~ /^[0-9]+$/) {
      result = fields[2]
      break
    }
  }
  close(path)
  return result
}
function native(name) {
  return name == "tailscaled" || name == "tailscale" || name == "foxydns" || name == "hev-socks5-tunnel" || name == "dnsmasq"
}
function quote(value) {
  gsub(/'/, "'\\''", value)
  return "'" value "'"
}
function component(path,    cmd, args, count, i, token, name, map, fields, comm) {
  comm = line(path "/comm")
  if (!(native(comm) || comm == "hev-socks5-tunne" || comm == "start.sh" || comm ~ /^(sh|ash|bash|mksh|busybox)$/ || comm ~ /^foxytail\.[a-z.-]+$/)) return ""
  # POSIX/BusyBox awk cannot reliably preserve NULs. Decode only candidates
  # through a pipe; raw arguments never touch a capture file. This subprocess
  # cost is diagnostic overhead, explicitly excluded from power claims.
  cmd = "tr '\\000' '\\n' < " quote(path "/cmdline") " 2>/dev/null"
  count = 0
  while (count < 3 && (cmd | getline token) > 0) args[++count] = token
  close(cmd)
  for (i = 1; i <= count; i++) {
    token = args[i]
    if (token ~ /^\/data\/adb\/foxytail\/scripts\/(foxytail\.[a-z.-]+|start\.sh)$/) {
      # Only an executable argument, never text inside a `sh -c` command.
      if (i == 1 || (i == 2 && args[1] ~ /(^|\/)(sh|ash|bash|mksh)$/)) {
        sub(/^.*\//, "", token)
        return token
      }
    }
  }
  name = args[1]
  sub(/^.*\//, "", name)
  if (!native(name)) return ""
  # argv[0] may be a bare command. Require its installed executable mapping,
  # avoiding attribution of another Tailscale installation by process name.
  while ((getline map < (path "/maps")) > 0) {
    split(map, fields, /[ \t]+/)
    if (fields[6] == "/data/adb/foxytail/bin/" name || (name == "tailscale" && fields[6] == "/data/adb/foxytail/bin/tailscaled")) {
      close(path "/maps")
      return name
    }
  }
  close(path "/maps")
  return ""
}
BEGIN {
  OFS = "\t"
  for (i = 1; i < ARGC; i++) {
    path = ARGV[i]
    pid = path
    sub(/^.*\//, "", pid)
    if (pid !~ /^[0-9]+$/ || !stat(path "/stat", fields)) continue
    paths[pid] = path
    starts[pid] = fields[20]
    parents[pid] = fields[2]
    labels[pid] = component(path)
    direct[pid] = labels[pid] != ""
  }
  # Include children that are alive at the sample, without pretending that
  # polling can count all execs. Do not include the diagnostic collector itself.
  for (depth = 0; depth < 8; depth++) {
    changed = 0
    for (pid in paths) {
      parent = parents[pid]
      if (labels[pid] == "" && labels[parent] != "" && starts[parent] <= starts[pid] && pid != collector_pid) {
        labels[pid] = labels[parent]
        changed++
      }
    }
    if (!changed) break
  }
  for (pid in paths) {
    if (labels[pid] == "" || pid == collector_pid) continue
    path = paths[pid]
    if (!stat(path "/stat", fields) || fields[20] != starts[pid]) continue
    user_ticks = fields[12]
    system_ticks = fields[13]
    rss = metric(path "/status", "VmRSS:")
    pss = collect_pss ? metric(path "/smaps_rollup", "Pss:") : "missing"
    reads = metric(path "/io", "read_bytes:")
    writes = metric(path "/io", "write_bytes:")
    rchar = metric(path "/io", "rchar:")
    wchar = metric(path "/io", "wchar:")
    voluntary = metric(path "/status", "voluntary_ctxt_switches:")
    involuntary = metric(path "/status", "nonvoluntary_ctxt_switches:")
    # The PID may exit/reappear between individual files. Discard mixed identity.
    if (!stat(path "/stat", check) || check[20] != starts[pid]) continue
    print sample, uptime, labels[pid], direct[pid] ? "direct" : "observed-child", pid, starts[pid], user_ticks, system_ticks, rss, pss, reads, writes, rchar, wchar, voluntary, involuntary
  }
  # ARGV contains proc directories, not input files for awk's implicit loop.
  exit 0
}
