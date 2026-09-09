#!/usr/bin/env python3
"""Summarize private Android proc samples without inventing unobserved work."""
import argparse
import csv
import json
from pathlib import Path

COUNTERS = (
    "user_ticks", "system_ticks", "read_bytes", "write_bytes", "rchar", "wchar",
    "main_thread_voluntary_switches", "main_thread_involuntary_switches",
)


def number(value):
    return int(value) if value and value.isascii() and value.isdecimal() else None


def summarize(directory):
    with (directory / "metadata.tsv").open() as source:
        metadata = dict(csv.reader(source, delimiter="\t"))
    with (directory / "samples.tsv").open() as source:
        samples = list(csv.DictReader(source, delimiter="\t"))
    with (directory / "processes.tsv").open() as source:
        rows = list(csv.DictReader(source, delimiter="\t"))
    previous, components, generations = {}, {}, {}
    for row in rows:
        name = row["component"]
        key = name, row["pid"], row["start_ticks"]
        generations.setdefault(name, set()).add(key)
        result = components.setdefault(name, {
            "observed_process_generations": 0,
            "observed_samples": 0,
            "rss_peak_kib": None,
            "pss_peak_kib": None,
            "counters": {metric: {"observed_delta": None, "comparable_intervals": 0,
                                   "missing_or_reset_intervals": 0} for metric in COUNTERS},
        })
        result["observed_samples"] += 1
        for metric in ("rss", "pss"):
            value = number(row[metric + "_kib"])
            if value is not None:
                result[metric + "_peak_kib"] = max(result[metric + "_peak_kib"] or 0, value)
        before = previous.get(key)
        if before is not None:
            for metric in COUNTERS:
                old, new = number(before[metric]), number(row[metric])
                counter = result["counters"][metric]
                if old is None or new is None or new < old:
                    counter["missing_or_reset_intervals"] += 1
                else:
                    counter["observed_delta"] = (counter["observed_delta"] or 0) + new - old
                    counter["comparable_intervals"] += 1
        previous[key] = row
    for name, result in components.items():
        result["observed_process_generations"] = len(generations[name])
    ticks = number(metadata.get("clock_ticks_per_second"))
    for result in components.values():
        user = result["counters"]["user_ticks"]["observed_delta"]
        system = result["counters"]["system_ticks"]["observed_delta"]
        result["observed_cpu_seconds"] = ((user + system) / ticks
                                          if ticks and user is not None and system is not None else None)
    duration = (float(samples[-1]["scan_end_uptime_seconds"]) - float(samples[0]["uptime_seconds"])) if samples else None
    return {
        "schema": 1,
        "metadata": metadata,
        "coverage": "partial; deltas only between observations of the same PID generation",
        "sample_count": len(samples),
        "observed_elapsed_seconds": duration,
        "scan_seconds": [round(float(s["scan_end_uptime_seconds"]) - float(s["uptime_seconds"]), 3) for s in samples],
        "components": components,
        "missing": ["short_lived_processes_between_samples", "exec_count", "status_rpc_count",
                    "sync_count", "all_thread_context_switches", "hardware_wakeups",
                    "energy_mwh", "deep_sleep_seconds", "observer_cpu_overhead"],
        "limitations": [
            "No observed component does not establish zero work; permission restrictions or polling can hide it.",
            "CPU and I/O deltas omit work before the first and after the last observation of each generation.",
            "RSS/PSS peaks are per observed process, not simultaneous component totals; PSS is opt-in.",
            "Context switches describe only each process's main thread; I/O uses procfs accounting, not physical flash writes.",
            "Scan time indicates measurement cost; diagnostic CPU/I/O and wireless ADB traffic are not subtracted.",
            "No power reduction is established by these process counters alone.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.directory), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
