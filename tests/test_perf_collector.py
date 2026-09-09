"""Host fixtures for the exact Android parser; no device/root/net changes."""
import csv
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PERF = ROOT / "tools/perf"
spec = importlib.util.spec_from_file_location("perf_summary", PERF / "summarize.py")
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)
HEADER = "sample uptime_seconds component attribution pid start_ticks user_ticks system_ticks rss_kib pss_kib read_bytes write_bytes rchar wchar main_thread_voluntary_switches main_thread_involuntary_switches".split()


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def process(self, pid, args, *, parent=1, start=100, mapped=None, io=True):
        path = self.root / str(pid)
        path.mkdir()
        fields = ["0"] * 22
        fields[0], fields[1] = "S", str(parent)
        fields[11], fields[12], fields[19] = "120", "30", str(start)
        (path / "stat").write_text(f"{pid} (name (with spaces)) " + " ".join(fields) + "\n")
        (path / "comm").write_text(Path(args[0]).name[:15] + "\n")
        (path / "cmdline").write_bytes(b"\0".join(x.encode() for x in args) + b"\0")
        (path / "status").write_text("VmRSS:\t125 kB\nvoluntary_ctxt_switches:\t21\nnonvoluntary_ctxt_switches:\t4\n")
        if io:
            (path / "io").write_text("read_bytes: 1024\nwrite_bytes: 4096\nrchar: 12000\nwchar: 9000\n")
        (path / "smaps_rollup").write_text("Pss:                82 kB\n")
        if mapped:
            (path / "maps").write_text(f"00400000-00500000 r-xp 00000000 00:00 12 {mapped}\n")
        return path

    def snapshot(self, pss=False):
        result = subprocess.run(["awk", "-v", "sample=0", "-v", "uptime=22.50", "-v",
                                 f"collect_pss={int(pss)}", "-f", str(PERF / "snapshot.awk"),
                                 *(str(path) for path in sorted(self.root.iterdir()) if path.is_dir())],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return list(csv.DictReader(result.stdout.splitlines(), fieldnames=HEADER, delimiter="\t")), result.stdout

    def test_identity_children_stat_parentheses_and_no_private_arguments(self):
        self.process(10, ["tailscaled", "--private=SECRET"], mapped="/data/adb/foxytail/bin/tailscaled")
        self.process(11, ["/system/bin/sh", "/data/adb/foxytail/scripts/foxytail.stats", "start"])
        self.process(12, ["jq", ".private.node"], parent=11)
        self.process(13, ["tailscaled"], mapped="/data/adb/other/bin/tailscaled")
        self.process(14, ["/system/bin/sh", "-c", "echo /data/adb/foxytail/scripts/foxytail.stats"])
        rows, raw = self.snapshot()
        found = {row["pid"]: row for row in rows}
        self.assertEqual(set(found), {"10", "11", "12"})
        self.assertEqual(found["12"]["attribution"], "observed-child")
        self.assertEqual(found["10"]["user_ticks"], "120")
        self.assertEqual(found["10"]["start_ticks"], "100")
        self.assertNotIn("SECRET", raw)
        self.assertNotIn("private", raw)

    def test_missing_io_and_optional_pss_are_never_zero(self):
        self.process(10, ["foxydns"], mapped="/data/adb/foxytail/bin/foxydns", io=False)
        rows, _ = self.snapshot()
        self.assertEqual(rows[0]["read_bytes"], "missing")
        self.assertEqual(rows[0]["pss_kib"], "missing")
        rows, _ = self.snapshot(pss=True)
        self.assertEqual(rows[0]["pss_kib"], "82")

    def test_tailscale_multicall_binary_is_attributed_as_cli(self):
        self.process(10, ["tailscale", "status", "--json"], mapped="/data/adb/foxytail/bin/tailscaled")
        rows, _ = self.snapshot()
        self.assertEqual(rows[0]["component"], "tailscale")

    def test_android_mksh_script_arguments_are_recognized(self):
        self.process(10, ["/system/bin/mksh", "/data/adb/foxytail/scripts/foxytail.logd", "start"])
        rows, _ = self.snapshot()
        self.assertEqual(rows[0]["component"], "foxytail.logd")

    @unittest.skipUnless(Path("/proc/uptime").is_file(), "full collector driver requires Linux procfs; Android properties remain fixtures")
    def test_bounded_collector_driver_with_fixture_android_metadata(self):
        commands = self.root / "commands"
        commands.mkdir()
        for name, body in {"id": "printf '0\\n'", "getprop": "printf 'fixture-build\\n'"}.items():
            executable = commands / name
            executable.write_text("#!/bin/sh\n" + body + "\n")
            executable.chmod(0o755)
        capture = self.root / "capture"
        env = os.environ.copy()
        env["PATH"] = str(commands) + os.pathsep + env["PATH"]
        result = subprocess.run(["sh", str(PERF / "collect-android.sh"), "--duration", "1", "--interval", "5",
                                 "--label", "host-fixture", "--build", "fixture", "--output", str(capture)],
                                capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(capture.stat().st_mode & 0o777, 0o700)
        metadata = dict(csv.reader((capture / "metadata.tsv").read_text().splitlines(), delimiter="\t"))
        self.assertEqual(metadata["exit_status"], "0")
        self.assertEqual(metadata["android_build"], "fixture-build")
        self.assertEqual(metadata["energy_mwh"], "missing")
        self.assertGreaterEqual(summary.summarize(capture)["sample_count"], 1)

    def test_collector_is_opt_in_and_rejects_unbounded_or_unsafe_inputs(self):
        cases = [[], ["--duration", "0"], ["--duration", "43201"],
                 ["--duration", "10", "--label", "unsafe\nlabel", "--build", "abc", "--output", str(self.root / "capture")]]
        for args in cases:
            result = subprocess.run(["sh", str(PERF / "collect-android.sh"), *args], capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "capture").exists())

    def test_pid_reuse_and_missing_counter_do_not_create_false_deltas(self):
        (self.root / "metadata.tsv").write_text("schema\t1\nclock_ticks_per_second\t100\n")
        (self.root / "samples.tsv").write_text("sample\tuptime_seconds\tscan_end_uptime_seconds\n0\t0\t0.1\n1\t15\t15.1\n2\t30\t30.1\n")
        with (self.root / "processes.tsv").open("w") as output:
            writer = csv.DictWriter(output, fieldnames=HEADER, delimiter="\t")
            writer.writeheader()
            for index, start, user, reads in [(0, 100, 120, "missing"), (1, 100, 140, "500"), (2, 200, 900, "9000")]:
                row = {key: "0" for key in HEADER}
                row.update(sample=str(index), uptime_seconds=str(index * 15), component="foxydns", pid="10", start_ticks=str(start),
                           user_ticks=str(user), system_ticks="30", read_bytes=reads, pss_kib="missing", rss_kib="123")
                writer.writerow(row)
        result = summary.summarize(self.root)
        native = result["components"]["foxydns"]
        self.assertEqual(native["observed_process_generations"], 2)
        self.assertEqual(native["observed_cpu_seconds"], 0.2)
        self.assertIsNone(native["counters"]["read_bytes"]["observed_delta"])
        self.assertEqual(native["counters"]["read_bytes"]["missing_or_reset_intervals"], 1)
        self.assertIsNone(native["pss_peak_kib"])
        self.assertIn("energy_mwh", result["missing"])


if __name__ == "__main__":
    unittest.main()
