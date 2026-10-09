#!/system/bin/sh
# ConnectivityService owns Android's default network; main-table routes do not.
# Sourced by settings.sh. Unknown/ambiguous snapshots never imply cellular.
network_snapshot() {
  {
    if tmo 5 dumpsys connectivity 2>/dev/null; then
      echo '__FOXY_NETWORK_SNAPSHOT_COMPLETE__'
    fi
  } | LC_ALL=C awk '
    function finish(  id,info,cap,fields,n,i,value,transport,iface,dns) {
      if (record=="") return
      info=record
      id=""
      if (match(info,/network\{[0-9]+\}/)) {
        id=substr(info,RSTART+8,RLENGTH-9)
      } else if (match(info,/- [0-9]+\]/)) {
        id=substr(info,RSTART+2,RLENGTH-3)
      }
      if (id=="") {record=""; return}
      cap=info
      if (match(cap,/Transports:[[:space:]]*/)) {
        cap=substr(cap,RSTART+RLENGTH)
        sub(/[[:space:]]+Capabilities:.*/,"",cap)
        sub(/\].*/,"",cap)
      } else {
        cap=""
        if (info ~ /ni\{WIFI[[:space:]]|NetworkAgentInfo[[:space:]]*\[WIFI[[:space:]]/) cap="WIFI"
        else if (info ~ /ni\{MOBILE\[|NetworkAgentInfo[[:space:]]*\[MOBILE[[:space:]]/) cap="CELLULAR"
        else if (info ~ /ni\{ETHERNET[[:space:]]|NetworkAgentInfo[[:space:]]*\[ETHERNET[[:space:]]/) cap="ETHERNET"
        else if (info ~ /ni\{VPN[[:space:]]|NetworkAgentInfo[[:space:]]*\[VPN[[:space:]]/) cap="VPN"
      }
      transport="unknown"
      if (cap ~ /(^|[|[:space:]])VPN([|[:space:]]|$)/) transport="vpn"
      else if (cap ~ /(^|[|[:space:]])WIFI([|[:space:]]|$)/) transport="wifi"
      else if (cap ~ /(^|[|[:space:]])CELLULAR([|[:space:]]|$)/) transport="cellular"
      else if (cap ~ /(^|[|[:space:]])ETHERNET([|[:space:]]|$)/) transport="ethernet"
      iface=""
      if (match(info,/InterfaceName:[[:space:]]*[A-Za-z0-9_.:-]+/)) {
        iface=substr(info,RSTART,RLENGTH); sub(/^InterfaceName:[[:space:]]*/,"",iface)
      }
      dns=""
      if (match(info,/DnsAddresses:[[:space:]]*\[[^]]*\]/)) {
        value=substr(info,RSTART,RLENGTH)
        sub(/^DnsAddresses:[[:space:]]*\[/,"",value); sub(/\]$/,"",value)
        n=split(value,fields,/[,[:space:]]+/)
        for (i=1;i<=n;i++) {
          value=fields[i]; sub(/^\//,"",value)
          if (value=="") continue
          if (length(value)>80 || value !~ /^[0-9A-Fa-f:.%_-]+$/ || value !~ /[.:]/) {invalid[id]=1; continue}
          dns=dns (dns=="" ? "" : " ") value
        }
      }
      count[id]++
      rows[id]=id "\t" transport "\t" iface "\t" dns
      if (transport=="unknown" || iface=="") invalid[id]=1
      record=""
    }
    {
      bytes+=length($0)+1
      if (bytes>2097152) {bad=1; exit}
      if ($0=="__FOXY_NETWORK_SNAPSHOT_COMPLETE__") {complete=1; finish(); next}
      if ($0 ~ /^[[:space:]]*Active default network:/) {
        value=$0; sub(/^[[:space:]]*Active default network:[[:space:]]*/,"",value); sub(/[[:space:]]*$/,"",value)
        if (value !~ /^[0-9]+$/ || active!="") bad=1
        active=value
      }
      if ($0 ~ /^[[:space:]]*NetworkAgentInfo[[:space:]{\[]/) {finish(); record=$0; next}
      if (record!="" && $0 ~ /^[[:space:]]*(LinkProperties|NetworkCapabilities|lp\{|nc\{)/) record=record " " $0
    }
    END {
      finish()
      if (!complete || bad || active=="" || count[active]!=1 || invalid[active]) print "unknown"
      else print rows[active]
    }
  ' | jqr -R -s -c '
    split("\n") | map(select(length>0))
    | if length!=1 or .[0]=="unknown" then
        {known:false,netId:"",transport:"unknown",interface:"",dns:[],signature:""}
      else .[0] | split("\t")
        | {known:true,netId:.[0],transport:.[1],interface:.[2],dns:(.[3]|split(" ")|map(select(length>0)))}
        | .signature=([.netId,.transport,.interface,(.dns|join(","))]|join("|"))
      end
    | ., (if .known then empty else error("Android default network is unavailable") end)
  ' 2>/dev/null
}
