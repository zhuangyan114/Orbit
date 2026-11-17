"""Rebuild offline fixtures only. This program has no probe/network/flash operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
VARIANTS = {
    "native-debug": (0, 1, 1, 0, 0),
    "cmsis-v1": (1, 1, 1, 0, 0),
    "cmsis-v2": (2, 1, 1, 0, 0),
    "native-optimized": (0, 1, 1, 0, 0),
    "native-no-stats": (0, 0, 1, 0, 0),
    "native-no-stack-bound": (0, 1, 0, 0, 0),
    "native-tickless": (0, 1, 1, 1, 0),
    "trace-continuous": (0, 1, 1, 0, 1),
    "trace-single-shot": (0, 1, 1, 0, 2),
    "trace-post-mortem": (0, 1, 1, 0, 3),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tool(name):
    result = shutil.which(name)
    if not result:
        raise RuntimeError("Missing tool on PATH: " + name)
    return str(Path(result).resolve())


def run(args, log=None):
    process = subprocess.run([str(item) for item in args], capture_output=True)
    text = (process.stdout + process.stderr).decode("utf-8", errors="replace")
    if log:
        Path(log).write_text(text, encoding="utf-8")
    if process.returncode:
        raise RuntimeError("Command failed: " + subprocess.list2cmdline([str(x) for x in args]) + "\n" + text[-14000:])
    return process.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")


def verify_vendor():
    manifest = json.loads((HERE / "vendor-manifest.json").read_text(encoding="utf-8"))
    names = [entry["path"] for entry in manifest["files"]]
    assert len({name.casefold() for name in names}) == len(names), "Case-only vendor paths are not portable on Windows"
    expected = set()
    for entry in manifest["files"]:
        path = (HERE / "vendor" / entry["path"]).resolve()
        if not path.is_relative_to((HERE / "vendor").resolve()):
            raise RuntimeError("Vendor path escapes source directory")
        data = path.read_bytes()
        assert len(data) == entry["bytes"] and digest(data) == entry["sha256"], entry["path"]
        expected.add(entry["path"])
    actual = {p.relative_to(HERE / "vendor").as_posix() for p in (HERE / "vendor").rglob("*") if p.is_file()}
    assert actual == expected, (actual - expected, expected - actual)
    return len(expected)


def build_firmware(output):
    gcc, objcopy, nm, objdump = [tool("arm-none-eabi-" + name) for name in ("gcc", "objcopy", "nm", "objdump")]
    build = output / "arm"
    make = tool("mingw32-make" if os.name == "nt" else "make")
    run([tool("cmake"), "-S", HERE, "-B", build, "-G",
         "MinGW Makefiles" if os.name == "nt" else "Unix Makefiles",
         "-DCMAKE_SYSTEM_NAME=Generic", "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
         "-DCMAKE_C_COMPILER=" + gcc, "-DCMAKE_ASM_COMPILER=" + gcc,
         "-DCMAKE_MAKE_PROGRAM=" + make], output / "configure.txt")
    run([tool("cmake"), "--build", build, "--parallel", "2"], output / "compile.txt")
    results = []
    for name, flags in VARIANTS.items():
        elf = build / (name + ".elf")
        config = output / (name + ".config.bin")
        run([objcopy, "--dump-section", ".fixture_config=" + str(config), elf])
        assert config.read_bytes() == struct.pack("<7I", 1, *flags, 4), name
        symbols = run([nm, "-S", "--defined-only", elf])
        dwarf = run([objdump, "--dwarf=info", elf])
        for symbol in ("pxCurrentTCB", "uxCurrentNumberOfTasks", "pxReadyTasksLists",
                       "xDelayedTaskList1", "xDelayedTaskList2", "xPendingReadyList",
                       "xTasksWaitingTermination", "xSuspendedTaskList", "fixtureTaskOracle",
                       "fixtureAmbiguousA", "fixtureAmbiguousB"):
            assert re.search(r"\b" + symbol + r"$", symbols, re.M), (name, symbol)
        assert "tskTaskControlBlock" in dwarf and "OrbitSameName" in dwarf and "DW_TAG_member" in dwarf, name
        if name.startswith("trace-"):
            assert re.search(r"\b_SEGGER_RTT$", symbols, re.M), name
        ready = re.search(r"^\w+\s+(\w+)\s+\w\s+pxReadyTasksLists$", symbols, re.M)
        static_tcb = re.search(r"^\w+\s+(\w+)\s+\w\s+workerTcb$", symbols, re.M)
        assert ready, name
        (output / (name + ".symbols.txt")).write_text(symbols, encoding="utf-8")
        (output / (name + ".dwarf.txt")).write_text(dwarf, encoding="utf-8")
        results.append({"name": name, "sha256": digest(elf.read_bytes()), "bytes": elf.stat().st_size,
                        "configuration": list(flags), "readyListBytes": int(ready[1], 16),
                        "staticTcbBytes": int(static_tcb[1], 16) if static_tcb else None,
                        "dwarf": True, "hardware": "not-run"})
        print("ELF verified:", name, flush=True)
    by_name = {image["name"]: image for image in results}
    # 比较编译结果，确认关闭字段和不同优先级配置确实改变目标 ABI。
    size = by_name["native-debug"]["staticTcbBytes"]
    assert by_name["native-no-stats"]["staticTcbBytes"] + 4 == size
    assert by_name["native-no-stack-bound"]["staticTcbBytes"] + 4 == size
    assert by_name["cmsis-v2"]["readyListBytes"] == by_name["native-debug"]["readyListBytes"] * 7
    stripped = build / "native-no-dwarf.elf"
    run([objcopy, "--strip-debug", build / "native-debug.elf", stripped])
    assert ".debug_info" not in run([objdump, "-h", stripped])
    assert "pxCurrentTCB" in run([nm, "--defined-only", stripped])
    results.append({"name": "native-no-dwarf", "sha256": digest(stripped.read_bytes()),
                    "bytes": stripped.stat().st_size, "dwarf": False, "hardware": "not-run"})
    return {"compiler": run([gcc, "--version"]).splitlines()[0], "images": results}


def build_samples(output, update):
    # 只编译官方记录器和 RTT；不引入 Orbit 的生产解码/编码模块。
    gcc = tool("gcc")
    include = [HERE / "config", HERE / "vendor/systemview/SYSVIEW",
               HERE / "vendor/systemview/SEGGER", HERE / "vendor/systemview/Config",
               HERE / "vendor/rtt/RTT"]
    reports = []
    for mode, name in ((1, "continuous"), (2, "single-shot"), (3, "post-mortem")):
        exe = output / ("recorder-" + name + (".exe" if os.name == "nt" else ""))
        args = [gcc, "-std=c11", "-O2", "-DFIXTURE_HOST=1", "-DFIXTURE_MODE=" + str(mode),
                "-DRTT_USE_ASM=0", "-D__forceinline=inline"]
        for directory in include:
            args += ["-I", directory]
        args += [HERE / "host/recorder.c", HERE / "vendor/systemview/SYSVIEW/SEGGER_SYSVIEW.c",
                 HERE / "vendor/rtt/RTT/SEGGER_RTT.c", "-o", exe]
        run(args, output / ("host-compile-" + name + ".txt"))
        cases = ["basic", "overflow"] if mode in (1, 2) else ["basic"]
        for case in cases:
            stem = name if case == "basic" else name + "-" + case
            raw, meta = output / (stem + ".bin"), output / (stem + ".json")
            run([exe, raw, meta, case])
            data, metadata = raw.read_bytes(), json.loads(meta.read_text(encoding="utf-8"))
            verify_sample(data, metadata)
            metadata["sha256"] = digest(data)
            metadata["source"] = "official SystemView 3.32 + RTT, deterministic single-thread host harness"
            metadata["hardware"] = "not-run"
            encoded = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            samples = HERE / "samples"
            if update:
                samples.mkdir(exist_ok=True)
                (samples / (stem + ".bin")).write_bytes(data)
                (samples / (stem + ".json")).write_bytes(encoded)
            else:
                assert data == (samples / (stem + ".bin")).read_bytes(), stem
                assert encoded == (samples / (stem + ".json")).read_bytes(), stem
            reports.append({"name": stem, "bytes": len(data), "sha256": digest(data)})
            print("Independent sample verified:", stem, flush=True)
    return reports


def verify_sample(data, metadata):
    oracle = json.loads((HERE / "host/oracle.json").read_text(encoding="utf-8"))
    assert metadata["frozen"] and metadata["stateAfterStop"] == 0
    assert metadata["mode"] in (1, 2, 3) and metadata["case"] in ("basic", "overflow")
    assert 0 < len(data) <= 1024 * 1024
    if "sha256" in metadata:
        assert digest(data) == metadata["sha256"]
    if metadata["mode"] in (2, 3):
        assert len(data) == metadata["retainedBytes"]
    if metadata["case"] == "basic" and metadata["mode"] != 3:
        # 人工字节 oracle 独立维护；不用生产常量、解码器或生成结果作期望值。
        assert data.startswith(bytes(10))
        assert [entry["name"] for entry in metadata["checks"]] == list(oracle["packets"])
        for check in metadata["checks"]:
            expected = bytes.fromhex(oracle["packets"][check["name"]])
            assert data[check["offset"]:check["offset"] + check["length"]] == expected, check
        assert metadata["stateBeforeStop"] == 1
        assert metadata["integrity"] == "complete"
    if metadata["mode"] == 3:
        assert metadata["wrapped"] and metadata["discardedPrefixBytes"] > 0
        assert bytes(10) in data
        assert metadata["rdOff"] != 0
        assert len(data) == metadata["bufferSize"] - 1
        assert metadata["integrity"] == "prefix-overwritten"
    if metadata["case"] == "overflow":
        assert metadata["overflowState"] == 2
        assert metadata["integrity"] == "target-overflow"
        if metadata["mode"] == 1:
            assert metadata["recovered"] and metadata["recoveryFirstByte"] == 1
            assert metadata["stateBeforeStop"] == 1
        else:
            assert not metadata["recovered"] and metadata["stateBeforeStop"] == 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "out/rtos-stage0/fixtures")
    parser.add_argument("--update-samples", action="store_true", help="Explicitly regenerate checked-in golden samples")
    parser.add_argument("--samples-only", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == HERE or output.is_relative_to(HERE):
        raise RuntimeError("Build output must be outside the checked-in fixture source")
    output.mkdir(parents=True, exist_ok=True)
    report = {"vendorFiles": verify_vendor(), "hardware": "not-run"}
    if not args.samples_only:
        report.update(build_firmware(output))
    report["samples"] = build_samples(output, args.update_samples)
    (output / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Offline verification passed:", output)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, AssertionError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
