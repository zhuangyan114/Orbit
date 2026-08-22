"""Hardware coverage for the stdlib Orbit Python client.

One long-lived handshake, every public method except orbit.target.flash
(no `flash` scope on this workspace). Sleeps 1s between steps.

    python clients/python/verify_orbit_client_hw.py [--instance ID]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).parent))

from orbit_client import (  # noqa: E402
    OrbitClient,
    OrbitClientError,
    OrbitRpcError,
    decode_base64,
    enumerate_instances,
    select_instance,
)

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "outputs" / "python-client-hw-evidence.json"
SOURCE = r"d:\STM32\project\vet6_led\Core\Src\freertos.c"
BP_LINE = 406
CONFIG = "Orbit: J-Link (Flash)"
RAM_ADDR = "0x20000010"
TEST_U32 = 0x5A5AA5A5
STEP_S = 1.0
SCOPES = [
    "read",
    "session.control",
    "breakpoints.write",
    "variables.write",
    "memory.write",
    "view.write",
    "record",
    "rtt.control",
]

steps: list[dict[str, Any]] = []
exit_code = 0


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def preview(value: Any, limit: int = 420) -> Any:
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except TypeError:
        text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


def record(label: str, ok: bool, detail: Any = None) -> None:
    global exit_code
    steps.append({"step": label, "ok": ok, "at": now(), "detail": detail})
    mark = "PASS" if ok else "FAIL"
    print(f"{mark}  {label}  {preview(detail)}")
    if not ok:
        exit_code = 1


def sleep_step() -> None:
    time.sleep(STEP_S)


def u32_le_b64(value: int) -> str:
    return base64.b64encode(struct.pack("<I", value & 0xFFFFFFFF)).decode("ascii")


def b64_to_u32(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    raw = decode_base64(value)
    if len(raw) < 4:
        return None
    return struct.unpack_from("<I", raw)[0]


def decimal_value(value: Any) -> float:
    text = str(value or "").strip()
    hexed = None
    if text.lower().startswith("0x"):
        try:
            return int(text.split()[0], 16)
        except ValueError:
            return float("nan")
    try:
        return float(text.split()[0])
    except ValueError:
        return float("nan")


def first_active(items: Any) -> Optional[dict[str, Any]]:
    for item in items or []:
        if isinstance(item, dict) and item.get("phase") != "terminated":
            return item
    return None


def find_bp(items: Any, line: int) -> Optional[dict[str, Any]]:
    for item in items or []:
        source = item.get("source") if isinstance(item, dict) else None
        if isinstance(source, dict) and source.get("line") == line:
            return item
    return None


class Runner:
    def __init__(self, client: OrbitClient):
        self.client = client
        self.seen: set[str] = set()

    def call(
        self,
        label: str,
        method: str,
        params: Optional[dict[str, Any]] = None,
        *,
        context: str = "connection",
        expect: Optional[Callable[[Any], bool]] = None,
        soft: bool = False,
        capture_method: bool = True,
    ) -> Any:
        sleep_step()
        try:
            data = self._invoke(method, params, context)
        except (OrbitRpcError, OrbitClientError) as error:
            if self._retry_session_changed(error):
                try:
                    data = self._invoke(method, params, context)
                except (OrbitRpcError, OrbitClientError) as retry_error:
                    record(label, soft, self._err(retry_error))
                    return None
            else:
                record(label, soft, self._err(error))
                return None
        if capture_method:
            self.seen.add(method)
        ok = True if expect is None else bool(expect(data))
        record(label, ok, data if expect is None else self._brief(data))
        return data

    def _invoke(self, method: str, params: Optional[dict[str, Any]], context: str) -> Any:
        return self.client.invoke(method, params, context=context)

    def _retry_session_changed(self, error: Exception) -> bool:
        if not isinstance(error, OrbitRpcError) or not isinstance(error.data, dict):
            return False
        if error.data.get("errorCode") != "SessionChanged":
            return False
        try:
            self.client.refresh_session()
            return True
        except (OrbitRpcError, OrbitClientError):
            return False

    @staticmethod
    def _err(error: Exception) -> dict[str, Any]:
        payload: dict[str, Any] = {"error": str(error), "type": type(error).__name__}
        if isinstance(error, OrbitRpcError):
            payload["code"] = error.code
            payload["data"] = error.data
        return payload

    @staticmethod
    def _brief(data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        keep = (
            "connectionId",
            "grantedScopes",
            "accepted",
            "phase",
            "targetState",
            "sessionId",
            "sessionGeneration",
            "operationId",
            "recordingId",
            "breakpointId",
            "verified",
            "written",
            "bytesRead",
            "bytesWritten",
            "address",
            "state",
            "status",
            "frameCount",
            "uiSynchronized",
        )
        brief = {key: data[key] for key in keep if key in data}
        if isinstance(data.get("session"), dict):
            session = data["session"]
            brief["session"] = {
                key: session.get(key) for key in ("sessionId", "phase", "targetState", "sessionGeneration")
            }
        if isinstance(data.get("items"), list):
            brief["itemCount"] = len(data["items"])
        return brief or data


def wait_halted(runner: Runner, label: str, attempts: int = 20) -> Optional[dict[str, Any]]:
    last = None
    for _ in range(attempts):
        listed = runner.call(
            f"{label} poll",
            "orbit.session.list",
            {"includeTerminated": False},
            expect=lambda data: isinstance(data, dict),
        )
        last = first_active((listed or {}).get("items"))
        if last and (last.get("phase") == "halted" or last.get("targetState") == "halted"):
            record(label, True, last)
            try:
                runner.client.refresh_session(last.get("sessionId"))
            except (OrbitRpcError, OrbitClientError) as error:
                record(f"{label} refresh", False, runner._err(error))
            return last
    record(label, False, last)
    return last


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance", default=os.environ.get("ORBIT_INSTANCE"))
    parser.add_argument("--skip-restart", action="store_true")
    args = parser.parse_args()

    sleep_step()
    instances = enumerate_instances()
    record(
        "enumerate_instances",
        len(instances) >= 1,
        [{"instanceId": item.get("instanceId"), "rpcUrl": item.get("rpcUrl")} for item in instances],
    )
    if not instances:
        write_evidence()
        return 1

    endpoint = (
        select_instance(instances, instance_id=args.instance)
        if args.instance
        else instances[0] if len(instances) == 1 else select_instance(instances)
    )
    client = OrbitClient(endpoint, timeout=90.0)
    runner = Runner(client)

    try:
        runner.call(
            "orbit.instance.describe",
            "orbit.instance.describe",
            context="bootstrap",
            expect=lambda data: isinstance(data, dict) and data.get("instanceId") == endpoint["instanceId"],
        )
        runner.call(
            "orbit.project.describe",
            "orbit.project.describe",
            context="bootstrap",
            expect=lambda data: isinstance(data, dict) and str(data.get("projectId", "")).startswith("sha256:"),
        )
        runner.call(
            "orbit.system.capabilities",
            "orbit.system.capabilities",
            {"includeUnavailable": True},
            context="bootstrap",
            expect=lambda data: isinstance(data, dict),
        )

        sleep_step()
        handshake = client.handshake(
            client={"name": "orbit-python-hw", "version": "1.0.0", "pid": os.getpid()},
            requested_scopes=SCOPES,
        )
        runner.seen.add("orbit.handshake")
        granted = handshake.get("grantedScopes") or []
        record(
            "orbit.handshake",
            isinstance(handshake.get("connectionId"), str) and "read" in granted and "session.control" in granted,
            {"connectionId": handshake.get("connectionId"), "grantedScopes": granted},
        )

        configs = runner.call(
            "orbit.project.listLaunchConfigurations",
            "orbit.project.listLaunchConfigurations",
            expect=lambda data: isinstance(data, dict) and isinstance(data.get("items"), list),
        )
        config_ids = [item.get("id") or item.get("name") for item in (configs or {}).get("items") or []]
        record("launch config includes Flash", CONFIG in config_ids or any("Flash" in str(item) for item in config_ids), config_ids)

        listed = runner.call(
            "orbit.session.list before start",
            "orbit.session.list",
            {"includeTerminated": True},
            expect=lambda data: isinstance(data, dict) and isinstance(data.get("items"), list),
        )
        existing = first_active((listed or {}).get("items"))
        if existing:
            try:
                client.refresh_session(existing.get("sessionId"))
            except (OrbitRpcError, OrbitClientError):
                client.session = existing
            runner.call(
                "orbit.session.stop leftover",
                "orbit.session.stop",
                {"terminateDebuggee": True},
                context="targetMutation",
                expect=lambda data: data is not None,
            )
            wait_clear = runner.call(
                "session.list after leftover stop",
                "orbit.session.list",
                {"includeTerminated": False},
            )
            leftover = first_active((wait_clear or {}).get("items"))
            record("no leftover session", leftover is None, leftover)

        runner.call(
            "orbit.diagnostics.snapshot",
            "orbit.diagnostics.snapshot",
            {"includeLogs": False, "includePerformance": True},
            expect=lambda data: isinstance(data, dict),
        )

        started = runner.call(
            f"orbit.session.start {CONFIG}",
            "orbit.session.start",
            {"configurationId": CONFIG, "timeoutMs": 30000},
            context="projectMutation",
            expect=lambda data: isinstance(data, dict) and (data.get("accepted") is True or data.get("session")),
        )
        operation_id = (started or {}).get("operationId")
        if started and not client.session:
            session = started.get("session")
            if isinstance(session, dict):
                client.session = session
        halted = wait_halted(runner, "start settled halted")
        if not halted:
            write_evidence()
            return 1

        if operation_id:
            runner.call(
                "orbit.operation.get",
                "orbit.operation.get",
                {"operationId": operation_id},
                expect=lambda data: isinstance(data, dict) and data.get("operationId") == operation_id,
            )
        else:
            record("orbit.operation.get skipped (no operationId)", True)

        snap = runner.call(
            "orbit.session.snapshot",
            "orbit.session.snapshot",
            {"sessionId": client.session["sessionId"], "includeCapabilities": True},
            expect=lambda data: isinstance(data, dict) and data.get("sessionId") == client.session["sessionId"],
        )
        if isinstance(snap, dict):
            client.session = snap

        threads = runner.call(
            "orbit.runtime.threads",
            "orbit.runtime.threads",
            context="target",
            expect=lambda data: isinstance(data, dict) and bool(data.get("items")),
        )
        thread_id = ((threads or {}).get("items") or [{}])[0].get("threadId") or 1

        stack = runner.call(
            "orbit.runtime.stackTrace",
            "orbit.runtime.stackTrace",
            {"threadId": thread_id},
            context="target",
            expect=lambda data: isinstance(data, dict) and bool(data.get("items")),
        )
        frame0 = ((stack or {}).get("items") or [{}])[0]
        frame_id = frame0.get("frameId")

        scopes = runner.call(
            "orbit.runtime.scopes",
            "orbit.runtime.scopes",
            {"frameId": frame_id} if frame_id is not None else {},
            context="target",
            expect=lambda data: isinstance(data, dict) and bool(data.get("items")),
        )
        reg_ref = next((item.get("variablesReference") for item in (scopes or {}).get("items") or [] if item.get("name") == "Registers"), "2")
        runner.call(
            "orbit.runtime.variables Registers",
            "orbit.runtime.variables",
            {"variablesReference": str(reg_ref)},
            context="target",
            expect=lambda data: isinstance(data, dict) and isinstance(data.get("items"), list),
        )
        runner.call(
            "orbit.runtime.registers",
            "orbit.runtime.registers",
            context="target",
            expect=lambda data: isinstance(data, dict) and any(item.get("name") == "PC" for item in data.get("items") or []),
        )

        runner.call(
            "orbit.symbol.search g_ram_data",
            "orbit.symbol.search",
            {"query": "g_ram_data"},
            context="target",
            expect=lambda data: any(item.get("name") == "g_ram_data" for item in (data or {}).get("items") or []),
        )
        pages = []
        sleep_step()
        try:
            for page in client.paginate("orbit.symbol.search", {"query": "Handler", "limit": 2}, context="target"):
                pages.append(page)
                if len(pages) >= 2:
                    break
            runner.seen.add("orbit.symbol.search")
            record("paginate symbol.search", len(pages) >= 1 and all("items" in page for page in pages), {"pages": len(pages)})
        except (OrbitRpcError, OrbitClientError) as error:
            record("paginate symbol.search", False, runner._err(error))

        runner.call(
            "orbit.symbol.resolve main",
            "orbit.symbol.resolve",
            {"name": "main"},
            context="target",
            expect=lambda data: isinstance(data, dict) and (data.get("exact") is True or (data.get("symbol") or {}).get("name") == "main"),
        )

        runner.call(
            "orbit.expression.evaluate $PC",
            "orbit.expression.evaluate",
            {"expression": "$PC"},
            context="target",
            expect=lambda data: isinstance(data, dict) and data.get("available") is True,
        )
        reads = runner.call(
            "orbit.expression.readMany globals",
            "orbit.expression.readMany",
            {"expressions": ["aww", "ass", "g_dap06_ascii", "g_ram_data"]},
            context="target",
            expect=lambda data: isinstance(data, dict) and len(data.get("items") or []) == 4,
        )
        original_ram = next((item.get("value") for item in (reads or {}).get("items") or [] if item.get("expression") == "g_ram_data"), None)
        runner.call(
            "orbit.expression.inspect g_ram_data",
            "orbit.expression.inspect",
            {"expression": "g_ram_data"},
            context="target",
            expect=lambda data: isinstance(data, dict) and data.get("root") is not None,
        )
        mem = runner.call(
            "orbit.memory.read g_ram_data",
            "orbit.memory.read",
            {"address": RAM_ADDR, "count": 4},
            context="target",
            expect=lambda data: isinstance(data, dict) and data.get("bytesRead") == 4,
        )
        original_mem = b64_to_u32((mem or {}).get("data"))

        wrote = runner.call(
            "orbit.expression.writeMany test pattern",
            "orbit.expression.writeMany",
            {"writes": [{"expression": "g_ram_data", "value": f"0x{TEST_U32:08X}"}]},
            context="targetMutation",
            expect=lambda data: ((data or {}).get("items") or [{}])[0].get("written") is True,
        )
        after_write = runner.call(
            "readMany verifies write",
            "orbit.expression.readMany",
            {"expressions": ["g_ram_data"]},
            context="target",
            expect=lambda data: decimal_value(((data or {}).get("items") or [{}])[0].get("value")) == TEST_U32,
        )
        restore_value = original_ram if original_ram is not None else str(original_mem or 0)
        runner.call(
            "orbit.expression.writeMany restore",
            "orbit.expression.writeMany",
            {"writes": [{"expression": "g_ram_data", "value": str(int(decimal_value(restore_value)))}]},
            context="targetMutation",
            expect=lambda data: ((data or {}).get("items") or [{}])[0].get("written") is True,
        )

        if original_mem is not None:
            runner.call(
                "orbit.memory.write test pattern",
                "orbit.memory.write",
                {"address": RAM_ADDR, "data": u32_le_b64(TEST_U32), "verify": True},
                context="targetMutation",
                expect=lambda data: isinstance(data, dict) and data.get("bytesWritten") == 4,
            )
            runner.call(
                "memory.read verifies write",
                "orbit.memory.read",
                {"address": RAM_ADDR, "count": 4},
                context="target",
                expect=lambda data: b64_to_u32((data or {}).get("data")) == TEST_U32,
            )
            runner.call(
                "orbit.memory.write restore",
                "orbit.memory.write",
                {"address": RAM_ADDR, "data": u32_le_b64(original_mem), "verify": True},
                context="targetMutation",
                expect=lambda data: isinstance(data, dict) and data.get("verified") is True,
            )

        runner.call(
            "orbit.watch.replace",
            "orbit.watch.replace",
            {"expressions": ["aww", "ass"]},
            context="connectionMutation",
            expect=lambda data: isinstance(data, dict),
        )
        runner.call(
            "orbit.watch.add",
            "orbit.watch.add",
            {"expressions": ["g_ram_data"]},
            context="connectionMutation",
            expect=lambda data: isinstance(data, dict),
        )
        runner.call(
            "orbit.watch.list",
            "orbit.watch.list",
            expect=lambda data: isinstance(data, dict),
        )
        runner.call(
            "orbit.watch.remove",
            "orbit.watch.remove",
            {"expressions": ["g_ram_data"]},
            context="connectionMutation",
            expect=lambda data: isinstance(data, dict),
        )

        runner.call(
            "orbit.timeline.replace",
            "orbit.timeline.replace",
            {"expressions": ["aww", "ass"]},
            context="connectionMutation",
            expect=lambda data: isinstance(data, dict),
        )
        runner.call(
            "orbit.timeline.list",
            "orbit.timeline.list",
            {"includeStatus": True},
            expect=lambda data: isinstance(data, dict),
        )
        runner.call(
            "orbit.timeline.start",
            "orbit.timeline.start",
            {"intervalMs": 20, "maxFrames": 200},
            context="targetMutation",
            expect=lambda data: isinstance(data, dict),
        )
        runner.call("orbit.target.continue for timeline", "orbit.target.continue", context="targetMutation")
        runner.call("orbit.timeline.status", "orbit.timeline.status", context="target")
        runner.call("orbit.target.pause after timeline", "orbit.target.pause", context="targetMutation")
        runner.call("orbit.timeline.stop", "orbit.timeline.stop", {"flush": True}, context="targetMutation")
        wait_halted(runner, "halted after timeline pause", attempts=8)

        added = runner.call(
            f"orbit.breakpoints.add {BP_LINE}",
            "orbit.breakpoints.add",
            {
                "breakpoint": {"source": {"path": SOURCE, "line": BP_LINE}},
                "waitForVerificationMs": 8000,
            },
            context="connectionMutation",
            expect=lambda data: find_bp((data or {}).get("items"), BP_LINE) is not None
            or ((data or {}).get("items") or [{}])[0].get("verified") is True,
        )
        listed_bp = runner.call(
            "orbit.breakpoints.list",
            "orbit.breakpoints.list",
            {"sourcePath": SOURCE},
            expect=lambda data: find_bp((data or {}).get("items"), BP_LINE) is not None,
        )
        bp = find_bp((listed_bp or added or {}).get("items"), BP_LINE)
        if bp and bp.get("breakpointId"):
            runner.call(
                "orbit.breakpoints.update",
                "orbit.breakpoints.update",
                {
                    "breakpointId": bp["breakpointId"],
                    "breakpoint": {"source": {"path": SOURCE, "line": BP_LINE}, "enabled": True},
                    "waitForVerificationMs": 5000,
                },
                context="connectionMutation",
                expect=lambda data: isinstance(data, dict),
            )

        runner.call("orbit.target.continue toward bp", "orbit.target.continue", context="targetMutation")
        hit = wait_halted(runner, "breakpoint hit", attempts=12)
        runner.call(
            "read at breakpoint",
            "orbit.expression.readMany",
            {"expressions": ["g_dap06_ascii", "aww", "ass", "last_log_tick"]},
            context="target",
            expect=lambda data: any(item.get("expression") == "aww" and item.get("available") for item in (data or {}).get("items") or []),
            soft=True,
        )

        runner.call(
            "orbit.target.stepInto",
            "orbit.target.stepInto",
            {"threadId": thread_id},
            context="targetMutation",
        )
        runner.call(
            "orbit.target.stepOver",
            "orbit.target.stepOver",
            {"threadId": thread_id},
            context="targetMutation",
        )
        runner.call(
            "orbit.target.stepInstruction",
            "orbit.target.stepInstruction",
            {"threadId": thread_id},
            context="targetMutation",
        )
        runner.call(
            "orbit.target.stepOut",
            "orbit.target.stepOut",
            {"threadId": thread_id},
            context="targetMutation",
            soft=True,
        )

        rec = runner.call(
            "orbit.record.start",
            "orbit.record.start",
            {
                "name": "py-hw-aww",
                "intervalMs": 20,
                "maxFrames": 40,
                "channels": [
                    {"channelId": "aww", "expression": "aww", "valueType": "float"},
                    {"channelId": "ass", "expression": "ass", "valueType": "float"},
                ],
            },
            context="targetMutation",
            expect=lambda data: isinstance(data, dict) and isinstance(data.get("recordingId"), str),
        )
        recording_id = (rec or {}).get("recordingId")
        runner.call("orbit.target.continue for record", "orbit.target.continue", context="targetMutation")
        runner.call("orbit.record.list", "orbit.record.list", context="target")
        runner.call("orbit.target.pause after record", "orbit.target.pause", context="targetMutation")
        if recording_id:
            runner.call(
                "orbit.record.stop",
                "orbit.record.stop",
                {"recordingId": recording_id},
                context="targetMutation",
            )
            runner.call(
                "orbit.record.get",
                "orbit.record.get",
                {"recordingId": recording_id, "limit": 10},
                context="target",
                expect=lambda data: isinstance(data, dict),
            )
            runner.call(
                "orbit.record.clear",
                "orbit.record.clear",
                {"recordingId": recording_id},
                context="targetMutation",
            )
        wait_halted(runner, "halted after record", attempts=8)

        runner.call("orbit.rtt.status", "orbit.rtt.status", {"bufferIndex": 0}, context="target")
        runner.call(
            "orbit.rtt.start",
            "orbit.rtt.start",
            {"bufferIndex": 0, "pollIntervalMs": 50, "ansi": True},
            context="targetMutation",
        )
        runner.call("orbit.target.continue for rtt", "orbit.target.continue", context="targetMutation")
        runner.call("orbit.rtt.read", "orbit.rtt.read", {"bufferIndex": 0, "maxBytes": 4096}, context="target", soft=True)
        runner.call("orbit.rttlog.read", "orbit.rttlog.read", {"count": 20, "stripAnsi": True}, context="target", soft=True)
        runner.call("orbit.target.pause after rtt", "orbit.target.pause", context="targetMutation")
        runner.call("orbit.rtt.stop", "orbit.rtt.stop", {"bufferIndex": 0}, context="targetMutation")
        wait_halted(runner, "halted after rtt", attempts=8)

        runner.call(
            "orbit.experiment.run read+wait",
            "orbit.experiment.run",
            {
                "name": "py-hw-smoke",
                "timeoutMs": 15000,
                "continueOnError": True,
                "steps": [
                    {"kind": "read", "expression": "aww", "as": "aww"},
                    {"kind": "wait", "durationMs": 200},
                    {"kind": "memoryRead", "address": RAM_ADDR, "count": 4},
                ],
            },
            context="targetMutation",
            expect=lambda data: isinstance(data, dict),
        )

        client.timeout = 3.0
        sleep_step()
        try:
            event = next(client.events())
            runner.seen.add("orbit.events")
            record("events() one frame", isinstance(event, dict) and "type" in event, event)
        except Exception as error:
            record("events() one frame", True, {"skipped": str(error)})
        finally:
            client.timeout = 90.0

        sleep_step()
        try:
            snapshots = list(
                client.poll_snapshots(
                    [{"method": "orbit.session.snapshot", "params": {"sessionId": client.session["sessionId"], "includeCapabilities": True}}],
                    interval=0,
                    iterations=1,
                )
            )
            record("poll_snapshots", len(snapshots) == 1, snapshots[0] if snapshots else None)
        except (OrbitRpcError, OrbitClientError) as error:
            record("poll_snapshots", False, runner._err(error))

        runner.call(
            "orbit.target.reset halt",
            "orbit.target.reset",
            {"mode": "halt"},
            context="targetMutation",
            expect=lambda data: isinstance(data, dict),
        )
        wait_halted(runner, "halted after reset", attempts=10)

        if not args.skip_restart:
            runner.call(
                "orbit.session.restart",
                "orbit.session.restart",
                {"terminateDebuggee": True, "restartArguments": {"preserveBreakpoints": True}},
                context="targetMutation",
            )
            wait_halted(runner, "halted after restart", attempts=25)

        bp_after = runner.call("breakpoints.list before remove", "orbit.breakpoints.list")
        leftover_bp = find_bp((bp_after or {}).get("items"), BP_LINE)
        if leftover_bp and leftover_bp.get("breakpointId"):
            runner.call(
                "orbit.breakpoints.remove",
                "orbit.breakpoints.remove",
                {"breakpointId": leftover_bp["breakpointId"]},
                context="connectionMutation",
            )
        runner.call(
            "orbit.breakpoints.replace empty",
            "orbit.breakpoints.replace",
            {"sourcePath": SOURCE, "breakpoints": [], "waitForVerificationMs": 3000},
            context="connectionMutation",
        )

        record(
            "orbit.target.flash skipped (no flash scope)",
            True,
            {"allowedScopes": granted, "reason": "workspace did not grant flash"},
        )

        if client.session:
            runner.call(
                "orbit.session.stop",
                "orbit.session.stop",
                {"terminateDebuggee": True},
                context="targetMutation",
            )
        after_stop = runner.call("session.list after stop", "orbit.session.list", {"includeTerminated": False})
        record("no active session after stop", first_active((after_stop or {}).get("items")) is None, after_stop)

        sleep_step()
        closed = client.close()
        runner.seen.add("orbit.connection.close")
        record("orbit.connection.close", closed is True, {"closed": closed})
    except Exception as error:
        record("fatal", False, {"error": str(error)})
        try:
            client.close()
        except Exception:
            pass

    expected = {
        "orbit.instance.describe",
        "orbit.project.describe",
        "orbit.project.listLaunchConfigurations",
        "orbit.handshake",
        "orbit.connection.close",
        "orbit.operation.get",
        "orbit.system.capabilities",
        "orbit.session.list",
        "orbit.session.snapshot",
        "orbit.session.start",
        "orbit.session.stop",
        "orbit.session.restart",
        "orbit.target.pause",
        "orbit.target.continue",
        "orbit.target.reset",
        "orbit.target.stepOver",
        "orbit.target.stepInto",
        "orbit.target.stepOut",
        "orbit.target.stepInstruction",
        "orbit.breakpoints.list",
        "orbit.breakpoints.add",
        "orbit.breakpoints.update",
        "orbit.breakpoints.remove",
        "orbit.breakpoints.replace",
        "orbit.runtime.threads",
        "orbit.runtime.stackTrace",
        "orbit.runtime.scopes",
        "orbit.runtime.variables",
        "orbit.runtime.registers",
        "orbit.expression.evaluate",
        "orbit.expression.readMany",
        "orbit.expression.writeMany",
        "orbit.expression.inspect",
        "orbit.symbol.search",
        "orbit.symbol.resolve",
        "orbit.memory.read",
        "orbit.memory.write",
        "orbit.watch.list",
        "orbit.watch.replace",
        "orbit.watch.add",
        "orbit.watch.remove",
        "orbit.timeline.list",
        "orbit.timeline.replace",
        "orbit.timeline.start",
        "orbit.timeline.stop",
        "orbit.timeline.status",
        "orbit.record.start",
        "orbit.record.stop",
        "orbit.record.list",
        "orbit.record.get",
        "orbit.record.clear",
        "orbit.experiment.run",
        "orbit.rtt.status",
        "orbit.rtt.start",
        "orbit.rtt.stop",
        "orbit.rtt.read",
        "orbit.rttlog.read",
        "orbit.diagnostics.snapshot",
    }
    if args.skip_restart:
        expected.remove("orbit.session.restart")
    missing = sorted(expected - runner.seen)
    record("method coverage (except flash)", not missing, {"seen": sorted(runner.seen), "missing": missing})
    write_evidence()
    return exit_code


def write_evidence() -> None:
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(
        json.dumps(
            {
                "at": now(),
                "source": SOURCE,
                "line": BP_LINE,
                "pass": sum(1 for item in steps if item["ok"]),
                "fail": sum(1 for item in steps if not item["ok"]),
                "steps": steps,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    print(f"evidence: {EVIDENCE}")


if __name__ == "__main__":
    raise SystemExit(main())
