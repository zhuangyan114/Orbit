"""Standard-library client for the Orbit Automation API v1."""

from __future__ import annotations

import json
import base64
import binascii
import os
import platform
import stat
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, MutableMapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class OrbitClientError(RuntimeError):
    pass


class InstanceNotFoundError(OrbitClientError):
    pass


class AmbiguousInstanceError(OrbitClientError):
    def __init__(self, candidates: list[dict[str, Any]]):
        self.candidates = candidates
        ids = ", ".join(item["instanceId"] for item in candidates)
        super().__init__(f"multiple Orbit instances match; specify instanceId ({ids})")


class OrbitRpcError(OrbitClientError):
    def __init__(self, message: str, code: int, data: Optional[dict[str, Any]] = None):
        self.code = code
        self.data = data
        super().__init__(message)


def decode_base64(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise OrbitClientError("invalid Base64 payload") from error


def default_registry_path(env: Optional[Mapping[str, str]] = None, system: Optional[str] = None) -> Path:
    values = os.environ if env is None else env
    override = values.get("ORBIT_AUTOMATION_REGISTRY")
    if override:
        return Path(override)
    current = (system or platform.system()).lower()
    if current == "windows":
        local = values.get("LOCALAPPDATA") or str(Path(values.get("USERPROFILE", "")) / "AppData" / "Local")
        return Path(local) / "Orbit" / "automation" / "registries.json"
    if current == "darwin":
        return Path(values.get("HOME", "~")) / "Library" / "Application Support" / "Orbit" / "automation" / "registries.json"
    runtime = values.get("XDG_RUNTIME_DIR") or str(Path(values.get("HOME", "~")) / ".local" / "state")
    return Path(runtime) / "orbit" / "automation" / "registries.json"


def _is_reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction and is_junction())


def _read_trusted_json(path: Path) -> Any:
    info = path.lstat()
    if _is_reparse(path) or not stat.S_ISREG(info.st_mode):
        raise OrbitClientError(f"untrusted registry file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _valid_loopback_url(value: Any, port: int, expected_path: str) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return (
        parsed.scheme == "http"
        and parsed.hostname == "127.0.0.1"
        and parsed.port == port
        and parsed.path == expected_path
        and not parsed.query
        and not parsed.fragment
    )


def _parse_endpoint(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("host") != "127.0.0.1":
        return None
    port = value.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        return None
    if (
        not isinstance(value.get("instanceId"), str)
        or not isinstance(value.get("projectId"), str)
        or not value["projectId"].startswith("sha256:")
        or not isinstance(value.get("token"), str)
        or not value["token"]
        or not _valid_loopback_url(value.get("rpcUrl"), port, "/v1/rpc")
        or not _valid_loopback_url(value.get("eventsUrl"), port, "/v1/events")
        or not _valid_loopback_url(value.get("healthUrl"), port, "/health")
        or not isinstance(value.get("apiVersions"), list)
        or "1.0" not in value["apiVersions"]
    ):
        return None
    return value


def _health_matches(endpoint: Mapping[str, Any], timeout: float) -> bool:
    try:
        request = Request(endpoint["healthUrl"], headers={"Accept": "application/json"})
        with urlopen(request, timeout=timeout) as response:
            health = json.loads(response.read().decode("utf-8"))
        return (
            health.get("ok") is True
            and health.get("instanceId") == endpoint["instanceId"]
            and health.get("projectId") == endpoint["projectId"]
            and health.get("apiVersion") == "1.0"
        )
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        return False


def enumerate_instances(
    *,
    registry_path: Optional[Path | str] = None,
    health_timeout: float = 2.0,
) -> list[dict[str, Any]]:
    pointer_path = Path(registry_path) if registry_path is not None else default_registry_path()
    try:
        pointer = _read_trusted_json(pointer_path)
    except FileNotFoundError:
        return []
    if not isinstance(pointer, dict) or pointer.get("schemaVersion") != 1 or not isinstance(pointer.get("registries"), list):
        raise OrbitClientError(f"untrusted registry pointer schema: {pointer_path}")

    candidates: list[dict[str, Any]] = []
    for registry in pointer["registries"]:
        if not isinstance(registry, dict) or not isinstance(registry.get("endpointDirectory"), str):
            continue
        directory = Path(registry["endpointDirectory"])
        try:
            if _is_reparse(directory) or not directory.is_dir():
                continue
            entries = list(directory.glob("*.json"))
        except OSError:
            continue
        for entry in entries:
            try:
                endpoint = _parse_endpoint(_read_trusted_json(entry))
                if endpoint is not None and _health_matches(endpoint, health_timeout):
                    candidates.append(endpoint)
            except (OrbitClientError, OSError, ValueError):
                continue

    by_instance: dict[str, dict[str, Any]] = {}
    for endpoint in candidates:
        current = by_instance.get(endpoint["instanceId"])
        if current is None or endpoint.get("heartbeatAt", 0) > current.get("heartbeatAt", 0):
            by_instance[endpoint["instanceId"]] = endpoint
    return sorted(by_instance.values(), key=lambda item: (item["projectId"], item["instanceId"]))


def select_instance(
    instances: Iterable[dict[str, Any]],
    *,
    project_id: Optional[str] = None,
    instance_id: Optional[str] = None,
) -> dict[str, Any]:
    candidates = list(instances)
    if project_id is not None:
        candidates = [item for item in candidates if item.get("projectId") == project_id]
    if instance_id is not None:
        candidates = [item for item in candidates if item.get("instanceId") == instance_id]
    if not candidates:
        raise InstanceNotFoundError("no live Orbit instance matches the requested identity")
    if len(candidates) > 1:
        raise AmbiguousInstanceError(candidates)
    return candidates[0]


class OrbitClient:
    def __init__(
        self,
        endpoint: Mapping[str, Any],
        *,
        request_id: Optional[Callable[[], str | int]] = None,
        timeout: float = 30.0,
    ):
        parsed = _parse_endpoint(dict(endpoint))
        if parsed is None:
            raise OrbitClientError("invalid Orbit endpoint")
        self.endpoint = parsed
        self.timeout = timeout
        self._sequence = 0
        self._request_id = request_id or self._next_id
        self.connection_id: Optional[str] = None
        self.registry_generation: Optional[int] = None
        self.session: Optional[dict[str, Any]] = None

    def _next_id(self) -> str:
        self._sequence += 1
        return f"req-{self._sequence}"

    def rpc(self, method: str, params: Mapping[str, Any]) -> dict[str, Any]:
        request_id = self._request_id()
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            self.endpoint["rpcUrl"],
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.endpoint['token']}",
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
            },
        )
        status = 200
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = response.status
                envelope = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            status = error.code
            try:
                envelope = json.loads(error.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise OrbitClientError(f"Orbit RPC failed with HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError) as error:
            raise OrbitClientError(f"Orbit RPC transport failed: {error}") from error
        if not isinstance(envelope, dict):
            raise OrbitClientError("Orbit RPC returned an invalid response envelope")
        rpc_error = envelope.get("error")
        if isinstance(rpc_error, dict):
            raise OrbitRpcError(
                str(rpc_error.get("message", "Orbit RPC failed")),
                int(rpc_error.get("code", -32603)),
                rpc_error.get("data") if isinstance(rpc_error.get("data"), dict) else None,
            )
        if isinstance(rpc_error, str) and rpc_error:
            # Transport-level failures (e.g. 401) return {"ok": false, "error": "..."}
            # rather than a JSON-RPC error envelope; keep the server's reason visible.
            raise OrbitClientError(f"Orbit RPC failed with HTTP {status}: {rpc_error}")
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise OrbitClientError("Orbit RPC response omitted result")
        return result

    def invoke(
        self,
        method: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        context: str = "connection",
        idempotency_key: Optional[str] = None,
    ) -> Any:
        wire_params = {"context": self._context(context, idempotency_key), **dict(params or {})}
        result = self.rpc(method, wire_params)
        data = result.get("data")
        self._capture_session(data)
        return data

    def handshake(
        self,
        *,
        client: Mapping[str, Any],
        requested_scopes: list[str],
        workspace_root: Optional[str] = None,
    ) -> dict[str, Any]:
        expected = {"projectId": self.endpoint["projectId"], "instanceId": self.endpoint["instanceId"]}
        if workspace_root is not None:
            expected["workspaceRoot"] = workspace_root
        data = self.invoke(
            "orbit.handshake",
            {
                "apiVersion": "1.0",
                "client": dict(client),
                "expected": expected,
                "requestedScopes": list(dict.fromkeys(requested_scopes)),
            },
            context="bootstrap",
        )
        if not isinstance(data, dict) or not isinstance(data.get("connectionId"), str):
            raise OrbitClientError("handshake response omitted connectionId")
        self.connection_id = data["connectionId"]
        project = data.get("project")
        if isinstance(project, dict) and isinstance(project.get("registryGeneration"), int):
            self.registry_generation = project["registryGeneration"]
        self._capture_session(data.get("session"))
        return data

    def refresh_session(self, session_id: Optional[str] = None) -> dict[str, Any]:
        requested_id = session_id or (self.session or {}).get("sessionId")
        if requested_id is None:
            page = self.invoke("orbit.session.list", {"includeTerminated": False})
            items = page.get("items", []) if isinstance(page, dict) else []
            if not items:
                raise OrbitClientError("no active Orbit debug session")
            if len(items) > 1:
                raise OrbitClientError("multiple active sessions; specify sessionId")
            requested_id = items[0]["sessionId"]
        session = self.invoke(
            "orbit.session.snapshot",
            {"sessionId": requested_id, "includeCapabilities": True},
        )
        if not self._is_session(session):
            raise OrbitClientError("session snapshot response is invalid")
        self.session = session
        return session

    def get_operation(self, operation_id: str) -> dict[str, Any]:
        data = self.invoke("orbit.operation.get", {"operationId": operation_id})
        if not isinstance(data, dict):
            raise OrbitClientError("operation response is invalid")
        return data

    def poll_snapshots(
        self,
        requests: Iterable[Mapping[str, Any]],
        *,
        interval: float = 1.0,
        iterations: Optional[int] = None,
    ) -> Iterator[dict[str, Any]]:
        request_list = list(requests)
        iteration = 0
        while iterations is None or iteration < iterations:
            for request in request_list:
                method = request.get("method")
                if not isinstance(method, str):
                    raise OrbitClientError("snapshot request method is required")
                data = self.invoke(
                    method,
                    request.get("params") if isinstance(request.get("params"), dict) else {},
                    context=str(request.get("context", "connection")),
                )
                yield {"method": method, "data": data}
            iteration += 1
            if iterations is None or iteration < iterations:
                time.sleep(max(0.0, interval))

    def paginate(
        self,
        method: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        context: str = "connection",
        idempotency_key: Optional[str] = None,
    ) -> Iterator[dict[str, Any]]:
        base_params = dict(params or {})
        cursor = base_params.get("cursor") if isinstance(base_params.get("cursor"), str) else None
        seen: set[str] = set()
        while True:
            request_params = {**base_params, **({"cursor": cursor} if cursor else {})}
            page = self.invoke(method, request_params, context=context, idempotency_key=idempotency_key)
            if not isinstance(page, dict) or not isinstance(page.get("items"), list):
                raise OrbitClientError(f"{method} response omitted items")
            yield page
            next_cursor = page.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                return
            if next_cursor in seen:
                raise OrbitClientError(f"{method} returned a repeated pagination cursor")
            seen.add(next_cursor)
            cursor = next_cursor

    def events(
        self,
        *,
        event_types: Optional[list[str]] = None,
        last_event_id: Optional[str] = None,
    ) -> Iterator[dict[str, Any]]:
        connection_id = self._require_connection()
        event_type_set = set(event_types or [])
        headers = {
            "Authorization": f"Bearer {self.endpoint['token']}",
            "X-Orbit-Connection-Id": connection_id,
            "Accept": "text/event-stream",
        }
        # urllib combines repeated request headers. The server treats each
        # X-Orbit-Event-Type value literally, so filter multiple types locally.
        if len(event_type_set) == 1:
            headers["X-Orbit-Event-Type"] = next(iter(event_type_set))
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        request = Request(self.endpoint["eventsUrl"], headers=headers)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                data_lines: list[str] = []
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                    if not line:
                        if data_lines:
                            event = json.loads("\n".join(data_lines))
                            if not self._is_event(event):
                                raise OrbitClientError("Orbit event stream returned an invalid event")
                            if not event_type_set or event["type"] in event_type_set:
                                yield event
                        data_lines = []
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise OrbitClientError(f"Orbit event stream failed: {error}") from error

    def close(self) -> bool:
        if self.connection_id is None:
            return False
        try:
            data = self.invoke("orbit.connection.close")
            return isinstance(data, dict) and data.get("closed") is True
        finally:
            self.connection_id = None
            self.session = None

    def _context(self, kind: str, idempotency_key: Optional[str]) -> dict[str, Any]:
        context: dict[str, Any] = {
            "instanceId": self.endpoint["instanceId"],
            "projectId": self.endpoint["projectId"],
        }
        if kind == "bootstrap":
            return context
        context["connectionId"] = self._require_connection()
        if kind in {"connectionMutation", "projectMutation", "targetMutation"}:
            context["idempotencyKey"] = idempotency_key or f"idem-{uuid.uuid4()}"
        if kind == "projectMutation":
            if not isinstance(self.registry_generation, int):
                raise OrbitClientError("project registry generation is unavailable; handshake again")
            context["registryGeneration"] = self.registry_generation
        if kind in {"target", "targetMutation"}:
            if not self._is_session(self.session):
                raise OrbitClientError("session context is unavailable; refresh the session first")
            context["sessionId"] = self.session["sessionId"]
            context["sessionGeneration"] = self.session["sessionGeneration"]
        return context

    def _require_connection(self) -> str:
        if self.connection_id is None:
            raise OrbitClientError("client is not handshaken")
        return self.connection_id

    def _capture_session(self, value: Any) -> None:
        if self._is_session(value):
            self.session = value
        elif isinstance(value, dict) and self._is_session(value.get("session")):
            self.session = value["session"]

    @staticmethod
    def _is_session(value: Any) -> bool:
        return (
            isinstance(value, dict)
            and isinstance(value.get("sessionId"), str)
            and isinstance(value.get("sessionGeneration"), int)
            and isinstance(value.get("phase"), str)
        )

    @staticmethod
    def _is_event(value: Any) -> bool:
        return (
            isinstance(value, dict)
            and isinstance(value.get("eventId"), str)
            and isinstance(value.get("instanceId"), str)
            and isinstance(value.get("projectId"), str)
            and isinstance(value.get("timestamp"), str)
            and isinstance(value.get("type"), str)
        )


__all__ = [
    "AmbiguousInstanceError",
    "InstanceNotFoundError",
    "OrbitClient",
    "OrbitClientError",
    "OrbitRpcError",
    "decode_base64",
    "default_registry_path",
    "enumerate_instances",
    "select_instance",
]
