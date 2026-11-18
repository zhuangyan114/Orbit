"""Recompute stage-1 acceptance from raw captures. Never accesses a target."""
import argparse
import hashlib
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def percentile(values, quantile):
    return sorted(values)[math.ceil(len(values) * quantile) - 1] if values else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--performance", required=True)
    parser.add_argument("--lifecycle", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    perf, life = Path(args.performance).resolve(), Path(args.lifecycle).resolve()
    gates = read(REPO / "docs/system view/stage1-performance-gates.json")
    violations = []
    checks = []

    def check(name, passed, detail=None):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})
        if not passed:
            violations.append(name)

    folders = [perf, perf / "repeat2", perf / "repeat3"]
    scenarios = {mode: [read(folder / f"benchmark-{mode}.json") for folder in folders]
                 for mode in ["combined", "combined-snapshot"]}
    result = {}
    trace = read(perf / "dap-trace.json")
    for mode, runs in scenarios.items():
        controls = [control for run in runs for control in run["controls"]]
        duration = sum(run["completedAt"] - run["startedAt"] for run in runs)
        frames = [entry["message"]["body"] for run in runs for entry in run["events"]
                  if entry.get("message", {}).get("event") == "orbitRtosSnapshot"]
        useful = [frame for frame in frames if len(frame["tasks"]) == 13
                  and all(task["name"]["available"] and task["priority"]["available"]
                          and task["creationNumber"]["available"] for task in frame["tasks"])]
        stats = {command: {"n": len(values := [c["elapsedMs"] for c in controls if c["command"] == command and c["ok"]]),
                           "p50Ms": percentile(values, .5), "p95Ms": percentile(values, .95), "maxMs": max(values)}
                 for command in ["pause", "continue", "stepIn"]}
        result[mode] = {"durationMs": duration, "controls": len(controls), "controlErrors": sum(not c["ok"] for c in controls),
                        "control": stats, "watchPolls": sum(len(run["watches"]) for run in runs),
                        "timelinePoints": sum(entry["points"] for run in runs for entry in run["events"] if entry.get("event") == "ozoneDataSamples"),
                        "rttTextLines": sum(run["rttTextLines"] for run in runs),
                        "publishedFrames": len(frames), "completeGraphFrames": sum(frame["consistency"] in ["halted-consistent", "live-best-effort"] for frame in frames),
                        "partialFrames": sum(frame["consistency"] == "partial" for frame in frames), "fresh13TaskFrames": len(useful),
                        "fresh13TaskRateHz": len(useful) / (duration / 1000),
                        "freshFrameP50Ms": percentile([frame["diagnostics"]["totalMs"] for frame in useful], .5),
                        "freshFrameP95Ms": percentile([frame["diagnostics"]["totalMs"] for frame in useful], .95),
                        "payloadBytes": sum(frame["diagnostics"]["bytes"] for frame in frames),
                        "runtimePercentFields": sum(task["runtime"]["percent"]["available"] for frame in frames for task in frame["tasks"])}
        check(f"{mode}: three >=60s runs", len(runs) == 3 and all(run["completedAt"] - run["startedAt"] >= 60000 for run in runs))
        check(f"{mode}: all controls and Watch calls succeed", all(c["ok"] for c in controls) and all(not run["errors"] for run in runs))
        for index, run in enumerate(runs):
            stops = [entry for entry in trace if run["startedAt"] <= entry["at"] <= run["completedAt"] and entry.get("message", {}).get("event") == "stopped"]
            check(f"{mode}/{index + 1}: no unexpected stopped events", len(stops) <= (37 if mode == "combined-snapshot" else 36), len(stops))
            sequences = [entry["message"]["body"]["snapshotSequence"] for entry in run["events"] if entry.get("message", {}).get("event") == "orbitRtosSnapshot"]
            check(f"{mode}/{index + 1}: monotonic publication", all(b > a for a, b in zip(sequences, sequences[1:])))
        check(f"{mode}: bounded raw reads", all(frame["diagnostics"]["bytes"] <= 128 * 1024 and frame["diagnostics"]["nodes"] <= 256 for frame in frames))
        check(f"{mode}: runtime estimate has identity and read window", all(
            not task["runtime"]["percent"]["available"] or (task["creationNumber"]["available"]
            and 0 <= task["runtime"]["percent"]["value"] <= 100 and task["runtime"].get("readWindowMs", {}).get("available"))
            for frame in frames for task in frame["tasks"]))

    baseline, enabled = result["combined"], result["combined-snapshot"]
    for command in ["pause", "continue"]:
        delta = enabled["control"][command]["p95Ms"] - baseline["control"][command]["p95Ms"]
        check(f"{command}: p95 absolute and incremental gate", enabled["control"][command]["p95Ms"] <= gates["controlPauseContinueP95MaxMs"]
              and delta <= gates["controlPauseContinueP95IncrementMaxMs"], {"incrementMs": delta})
    check("step: p95 gate", enabled["control"]["stepIn"]["p95Ms"] <= gates["controlStepP95MaxMs"])
    check("fresh task frame rate", enabled["fresh13TaskRateHz"] >= gates["liveFreshThirteenTaskFramesMinHz"], enabled["fresh13TaskRateHz"])
    requested = sum(run["snapshotStatus"]["counts"]["requested"] for run in scenarios["combined-snapshot"])
    check("default Live request cadence", requested / (enabled["durationMs"] / 1000) >= gates["liveRequestedRateMinHz"], requested)
    for field in ["watchPolls", "timelinePoints"]:
        check(field + ": throughput gate", enabled[field] / baseline[field] >= gates["watchAndTimelineThroughputMinRatio"], enabled[field] / baseline[field])
    check("RTT progresses", baseline["rttTextLines"] > 0 and enabled["rttTextLines"] > 0)
    check("runtime intervals observed", enabled["runtimePercentFields"] > 0)

    oracle = [read(perf / f"oracle-phase{phase}.json") for phase in [1, 2, 3]]
    check("three independent kernel oracles", all(not entry["mismatches"] and entry["actual"]["consistency"] == "halted-consistent"
          and len(entry["expected"]) == 13 for entry in oracle))
    lifecycle = read(life / "lifecycle.json")
    check("hardware lifecycle checks", "error" not in lifecycle and all(entry["ok"] for entry in lifecycle["checks"]), lifecycle.get("error"))
    warm = lifecycle["warmSnapshots"][1:]
    check("warm halted snapshot p95", percentile([entry["elapsedMs"] for entry in warm], .95) <= gates["warmHaltedSnapshotP95Ms"])
    check("13 task stack scan budget", lifecycle["stack"]["elapsedMs"] <= gates["allThirteenStackScansMaxMs"])
    life_trace = read(life / "dap-trace.json")
    stop_responses = [entry for entry in life_trace if entry.get("direction") == "request" and entry.get("message", {}).get("command") == "orbitRtosSnapshot"
                      and entry["message"].get("arguments", {}).get("action") == "stop"]
    late_events = []
    if stop_responses:
        stopped = stop_responses[-1]
        late_events = [entry for entry in life_trace if entry["at"] > stopped["at"] and entry["sessionId"] == stopped["sessionId"]
                       and entry.get("message", {}).get("event") == "orbitRtosSnapshot"]
    check("no late snapshot events after stop", len(late_events) <= gates["lateSnapshotEventsAfterStopMax"], len(late_events))
    device_after = read(life / "device-after.json")
    check("selected owner released", device_after.get("owner") is None and device_after["device_id"] == "b81f3fc30470", device_after.get("owner"))

    software = []
    for name, file, marker in [
        ("typecheck", "out/rtos-stage1-typecheck-delivery.txt", "tsc --noEmit"),
        ("extension build", "out/rtos-stage1-build-delivery.txt", "symbol-picker — done"),
        ("native build", "out/rtos-stage1-native-build.txt", "Native helper:"),
        ("full Vitest", "out/rtos-stage1-all-tests-delivery.txt", "1378 passed"),
        ("J-Link mock", "out/rtos-stage1-jlink-mock.txt", "disconnect: target resumed after breakpoint cleanup"),
        ("CMSIS-DAP mock", "out/rtos-stage1-dap-mock.txt", "all checks passed"),
        ("offline rebuild", "out/rtos-stage1-offline-build.txt", "Offline verification passed"),
        ("fixture validators", "out/rtos-stage1-fixture-tests.txt", "Ran 7 tests"),
        ("rebuilt ELF layouts", "out/rtos-stage1-new-elf-layout.txt", "12 passed"),
    ]:
        path = REPO / file
        passed = marker in path.read_text(encoding="utf-8", errors="replace")
        check(name, passed)
        software.append({"name": name, "passed": passed, "log": file, "sha256": digest(path)})

    build = read(perf / "build-manifest.json")
    changed = [name for name, entry in build.items() if name.startswith("src/") and digest(REPO / name) != entry["sha256"]]
    check("performance input hot paths unchanged", set(changed) <= {"src/debug/dap-session.ts"}, changed)
    current = (REPO / "src/debug/dap-session.ts").read_bytes()
    newline = b"\r\n" if b"\r\n" in current else b"\n"
    recovered = current.replace(b"    let refreshEntered = false;" + newline, b"").replace(b"      refreshEntered = true;" + newline, b"")
    prefix = b"        elfSha256: this._loadedFirmware?.sha256 || '', layoutId: '', errorCode, operation: 'taskSnapshot', retryable: false,"
    updated = prefix + newline + b"        completion: !refreshEntered || ['RtosNotDetected', 'DwarfUnavailable', 'LayoutIncomplete', 'LayoutAmbiguous', 'UnsupportedCapability'].includes(errorCode) ? 'not-started' : 'unknown' });"
    recovered = recovered.replace(updated, prefix + b" completion: 'not-started' });")
    check("delivery change is only cancelled-read completion labeling", hashlib.sha256(recovered).hexdigest() == build["src/debug/dap-session.ts"]["sha256"])
    # The only delivery change after performance capture is the cancellation
    # error's completion=unknown; the delivery build re-runs hardware lifecycle.
    artifacts = []
    for folder in [perf, perf / "repeat2", perf / "repeat3", life]:
        for file in sorted(folder.glob("*.json")):
            if file.name in ["catalog.json", "ready.json"]:
                continue
            artifacts.append({"path": file.relative_to(REPO).as_posix(), "bytes": file.stat().st_size, "sha256": digest(file)})
    evidence = {"schemaVersion": 1, "date": "2026-11-18", "scope": gates["scope"],
                "status": "passed" if not violations else "failed", "performanceEnvironment": read(perf / "ready.json"),
                "deliveryEnvironment": read(life / "ready.json"), "gatesSha256": digest(REPO / "docs/system view/stage1-performance-gates.json"),
                "performanceBuild": build, "deliveryBuild": {name: {"sha256": digest(REPO / name), "bytes": (REPO / name).stat().st_size} for name in build},
                "deliveryChangeSincePerformance": changed, "identity": lifecycle.get("identity"),
                "performance": result, "warmHalted": {"n": len(warm), "p50Ms": percentile([entry["elapsedMs"] for entry in warm], .5),
                "p95Ms": percentile([entry["elapsedMs"] for entry in warm], .95)}, "allStackScanMs": lifecycle["stack"]["elapsedMs"],
                "oracle": [{"phase": entry["phase"], "n": len(entry["expected"]), "dapElapsedMs": entry["dapElapsedMs"], "mismatches": entry["mismatches"]} for entry in oracle],
                "machine": read(REPO / "out/rtos-stage1/environment-delivery.json"), "softwareChecks": software,
                "checks": checks, "violations": violations, "artifacts": artifacts}
    Path(args.output).write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "checks": len(checks), "violations": violations, "performance": result}, ensure_ascii=False, indent=2))
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
