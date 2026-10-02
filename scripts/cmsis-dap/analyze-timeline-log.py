"""Offline statistics for an archived CMSIS-DAP DAP/dll log pair. No target access."""
import argparse
import collections
import hashlib
import json
import math
import re
from pathlib import Path


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def distribution(values):
    return {
        "count": len(values),
        "mean": sum(values) / len(values) if values else None,
        "p50": percentile(values, .5),
        "p95": percentile(values, .95),
        "max": max(values) if values else None,
    }


def milliseconds(line):
    match = re.match(r"(\d\d):(\d\d):(\d\d)\.(\d{3})", line)
    if not match:
        return None
    hour, minute, second, ms = map(int, match.groups())
    return ((hour * 60 + minute) * 60 + second) * 1000 + ms


def time_text(ms, offset_hours=0):
    hour, rest = divmod(int(ms) + offset_hours * 3600000, 3600000)
    minute, rest = divmod(rest, 60000)
    second, remainder = divmod(rest, 1000)
    return f"{hour % 24:02}:{minute:02}:{second:02}.{remainder:03}"


def analyze(directory, timeline_variables):
    sources = {}
    logs = {}
    for category in ("dap", "dll"):
        file = directory / f"{category}.log"
        raw = file.read_bytes()
        logs[category] = raw.decode("utf-8-sig").splitlines()
        sources[category] = {
            "file": str(file), "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw), "lines": len(logs[category]),
        }
    samples, watch_reads, watch_slow, rtt = [], [], [], []
    evidence, errors = [], []
    batch_shapes = collections.Counter()
    running = False
    segment = 0
    segments = collections.defaultdict(list)
    for number, line in enumerate(logs["dap"], 1):
        time = milliseconds(line)
        if time is None:
            continue
        if "event=continued" in line:
            running = True
            segment += 1
        if "event=stopped" in line:
            running = False
        if any(term in line for term in ("Launch:", "调试路径:", "[timeline] start", "event=continued", "event=stopped")):
            evidence.append({"category": "dap", "line": number, "text": line})
        batch = re.search(r"readMemoryBatch reads=(\d+) bytes=(\d+) owner=cmsis-dap", line)
        if batch:
            shape = tuple(map(int, batch.groups()))
            batch_shapes[str(shape)] += 1
            if running and shape == (timeline_variables, 4 * timeline_variables):
                samples.append((time, number))
                segments[segment].append(time)
            if running and shape == (3, 10):
                watch_reads.append(time)
        watch = re.search(r"\[watch\] batch expressions=(\d+) expanded=(\d+).*maxChunkMs=(\d+) elapsedMs=(\d+)", line)
        if running and watch:
            watch_slow.append(dict(zip(("expressions", "expanded", "maxChunkMs", "elapsedMs"), map(int, watch.groups()))))
        rtt_match = re.search(r"readRtt buffer=(\d+) requested=(\d+) read=(\d+).*overrun=(true|false)", line)
        if running and rtt_match:
            rtt.append({"timeMs": time, "requested": int(rtt_match[2]), "read": int(rtt_match[3]), "overrun": rtt_match[4] == "true"})
    for category, lines in logs.items():
        for number, line in enumerate(lines, 1):
            if category == "dll" and any(term in line for term in ("opened device", "spawned pid", "connected port", "process] exit")):
                evidence.append({"category": category, "line": number, "text": line})
            if "ok=false" in line or any(term in line for term in ("ReadTimeout", "WriteTimeout", "NativeOwnerLost", "DeviceRemoved")):
                errors.append({"category": category, "line": number, "text": line})
    if not samples:
        raise ValueError("No running-state Timeline read completions matched the requested scalar count")
    first, last = samples[0][0], samples[-1][0]
    duration = sum((times[-1] - times[0]) / 1000 for times in segments.values() if len(times) > 1)
    intervals = [b - a for times in segments.values() for a, b in zip(times, times[1:])]
    windows = []
    for start in range(first, last, 60000):
        end = min(start + 60000, last)
        count = sum(start <= time < end for time, _ in samples)
        windows.append({"startBeijing": time_text(start, 8), "endBeijing": time_text(end, 8),
                        "durationSeconds": (end - start) / 1000, "reads": count,
                        "estimatedHzPerExpression": count * 1000 / (end - start)})
    gaps = [{"fromBeijing": time_text(a, 8), "toBeijing": time_text(b, 8), "ms": b - a}
            for times in segments.values() for a, b in zip(times, times[1:]) if b - a > 30]
    return {
        "sources": sources, "evidence": evidence, "allReadBatchShapes": dict(batch_shapes),
        "timeline": {"variables": timeline_variables, "firstBeijing": time_text(first, 8),
                     "lastBeijing": time_text(last, 8), "firstLine": samples[0][1], "lastLine": samples[-1][1],
                     "runningSegments": len(segments), "durationSeconds": duration, "readCompletions": len(samples),
                     "estimatedHzPerExpression": sum(len(times) - 1 for times in segments.values()) / duration,
                     "completionGapMs": distribution(intervals), "gapsOver30ms": gaps, "windows": windows,
                     "limitation": "Successful scalar-batch read completion proxy; does not count DAP events or webview-delivered points."},
        "watch": {"runningSlowBatchCount": len(watch_slow),
                  "expressionCounts": dict(collections.Counter(str(item["expressions"]) for item in watch_slow)),
                  "loggedSlowBatchElapsedMs": distribution([item["elapsedMs"] for item in watch_slow]),
                  "loggedSlowBatchMaxChunkMs": distribution([item["maxChunkMs"] for item in watch_slow]),
                  "watchReadProxyCount": len(watch_reads),
                  "watchReadProxyGapMs": distribution([b - a for a, b in zip(watch_reads, watch_reads[1:])]),
                  "limitation": "Watch latency logs include only batches >=16ms; these statistics are conditional, not all Watch requests. 3 reads/10 bytes is the observed Watch read proxy for this workload."},
        "rtt": {"polls": len(rtt), "readBytes": sum(item["read"] for item in rtt),
                "positivePolls": sum(item["read"] > 0 for item in rtt), "overruns": sum(item["overrun"] for item in rtt),
                "requestedSizes": dict(collections.Counter(str(item["requested"]) for item in rtt)),
                "completionGapMs": distribution([b["timeMs"] - a["timeMs"] for a, b in zip(rtt, rtt[1:])])},
        "errors": errors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--timeline-variables", type=int, default=2)
    args = parser.parse_args()
    result = analyze(args.directory, args.timeline_variables)
    destination = args.directory / "analysis.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"saved": str(destination), "timeline": result["timeline"], "watch": result["watch"], "rtt": result["rtt"], "errors": len(result["errors"])}, ensure_ascii=False, indent=2))
