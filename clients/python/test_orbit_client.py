import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from orbit_client import (  # noqa: E402
    AmbiguousInstanceError,
    OrbitClient,
    OrbitClientError,
    OrbitRpcError,
    decode_base64,
    enumerate_instances,
    select_instance,
)

INSTANCE_ID = "instance-a"
PROJECT_ID = "sha256:project-a"
CONNECTION_ID = "conn-a"
SESSION_ID = "session-a"
FIXTURES = json.loads(
    (Path(__file__).parents[1] / "test-fixtures" / "wire-payloads.json").read_text(encoding="utf-8")
)


def endpoint(port, instance_id=INSTANCE_ID):
    return {
        "schemaVersion": 1,
        "instanceId": instance_id,
        "projectId": PROJECT_ID,
        "channel": "stable",
        "profile": "",
        "extensionHost": "local",
        "workspaceFolders": [r"C:\project"],
        "host": "127.0.0.1",
        "port": port,
        "rpcUrl": f"http://127.0.0.1:{port}/v1/rpc",
        "eventsUrl": f"http://127.0.0.1:{port}/v1/events",
        "healthUrl": f"http://127.0.0.1:{port}/health",
        "token": "token-a",
        "processId": 123,
        "startedAt": 1700000000000,
        "heartbeatAt": 1700000000000,
        "apiVersions": ["1.0"],
    }


class FakeApi:
    def __init__(self):
        self.requests = []
        self.event_filter_headers = []
        self.session = {
            "sessionId": SESSION_ID,
            "sessionGeneration": 7,
            "registryGeneration": 7,
            "name": "fixture",
            "type": "orbit",
            "phase": "halted",
            "targetState": "halted",
            "capabilities": [],
        }
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    self._json({"ok": True, "status": "ok", "instanceId": INSTANCE_ID, "projectId": PROJECT_ID, "apiVersion": "1.0"})
                    return
                if self.path == "/v1/events":
                    if self.headers.get("Authorization") != "Bearer token-a":
                        self.send_error(401)
                        return
                    if self.headers.get("X-Orbit-Connection-Id") != CONNECTION_ID:
                        self.send_error(400)
                        return
                    outer.event_filter_headers.append(self.headers.get("X-Orbit-Event-Type"))
                    event = {
                        "eventId": "0000000000000001",
                        "instanceId": INSTANCE_ID,
                        "projectId": PROJECT_ID,
                        "sessionId": SESSION_ID,
                        "sessionGeneration": 7,
                        "timestamp": "1700000000000",
                        "type": "target.stopped",
                        "data": {"reason": "breakpoint"},
                    }
                    body = f"id: {event['eventId']}\r\nevent: {event['type']}\r\ndata: {json.dumps(event, separators=(',', ':'))}\r\n\r\n".encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_error(404)

            def do_POST(self):
                if self.path != "/v1/rpc":
                    self.send_error(404)
                    return
                if self.headers.get("Authorization") != "Bearer token-a":
                    self._json({"ok": False, "error": "Unauthorized"}, status=401)
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                method = body["method"]
                if method == "orbit.handshake":
                    data = {
                        "connectionId": CONNECTION_ID,
                        "expiresAt": "1700000600000",
                        "grantedScopes": ["read"],
                        "instance": {"instanceId": INSTANCE_ID},
                        "project": {"projectId": PROJECT_ID, "registryGeneration": 7},
                        "capabilities": {"apiVersion": "1.0", "capabilities": []},
                        "session": outer.session,
                    }
                elif method == "orbit.session.snapshot":
                    data = outer.session
                elif method == "orbit.operation.get":
                    data = {"operationId": "op-a", "status": "succeeded", "dispatchedAt": "1700000000000"}
                elif method == "orbit.record.get":
                    if body["params"].get("cursor"):
                        data = {"recording": {"recordingId": "record-a"}, "items": [{"frameId": "frame-2", "timestamp": "1700000000002"}]}
                    else:
                        data = {"recording": {"recordingId": "record-a"}, "items": [{"frameId": "frame-1", "timestamp": "1700000000001"}], "nextCursor": "frame-1"}
                elif method == "orbit.expression.evaluate":
                    self._json({
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "error": {"code": -32015, "message": "InvalidRequest", "data": {"errorCode": "InvalidRequest", "retryable": False}},
                    })
                    return
                else:
                    self.send_error(500)
                    return
                self._json({
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "requestId": body["id"],
                        "instanceId": INSTANCE_ID,
                        "projectId": PROJECT_ID,
                        "data": data,
                    },
                })

            def _json(self, payload, status=200):
                body = json.dumps(payload, separators=(",", ":")).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self):
        return self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class OrbitPythonClientTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()

    def tearDown(self):
        self.api.close()

    def test_discovers_healthy_endpoints_and_rejects_ambiguity(self):
        with tempfile.TemporaryDirectory(prefix="orbit-python-client-") as root:
            root_path = Path(root)
            endpoint_dir = root_path / "endpoints"
            endpoint_dir.mkdir()
            endpoint_file = endpoint(self.api.port)
            (endpoint_dir / f"{INSTANCE_ID}.json").write_text(json.dumps(endpoint_file), encoding="utf-8")
            registry = {
                "schemaVersion": 1,
                "registries": [{
                    "channel": "stable",
                    "profile": "",
                    "extensionHost": "local",
                    "endpointDirectory": str(endpoint_dir),
                    "updatedAt": 1700000000000,
                }],
            }
            registry_path = root_path / "registries.json"
            registry_path.write_text(json.dumps(registry), encoding="utf-8")

            discovered = enumerate_instances(registry_path=registry_path)
            self.assertEqual(discovered, [endpoint_file])
            self.assertEqual(select_instance(discovered, project_id=PROJECT_ID), endpoint_file)
            with self.assertRaises(AmbiguousInstanceError):
                select_instance([endpoint_file, endpoint(self.api.port, "instance-b")], project_id=PROJECT_ID)
            self.assertEqual(
                select_instance([endpoint_file, endpoint(self.api.port, "instance-b")], instance_id="instance-b")["instanceId"],
                "instance-b",
            )

    def test_uses_shared_wire_payloads_and_event_stream(self):
        counter = iter(range(1, 10))
        client = OrbitClient(endpoint(self.api.port), request_id=lambda: f"req-{next(counter)}")
        handshake = client.handshake(
            client={"name": "fixture-client", "version": "1.0.0"},
            requested_scopes=["read"],
        )
        self.assertEqual(handshake["connectionId"], CONNECTION_ID)
        self.assertEqual(client.session["sessionId"], SESSION_ID)
        self.assertEqual(client.refresh_session(SESSION_ID)["sessionGeneration"], 7)
        self.assertEqual(client.get_operation("op-a")["status"], "succeeded")
        snapshots = list(client.poll_snapshots(
            [{"method": "orbit.session.snapshot", "params": {"sessionId": SESSION_ID, "includeCapabilities": True}}],
            iterations=1,
            interval=0,
        ))
        self.assertEqual(snapshots[0]["data"], self.api.session)
        events = list(client.events(event_types=["watch.changed", "target.stopped"]))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "target.stopped")
        self.assertEqual(self.api.event_filter_headers, [None])
        pages = list(client.paginate("orbit.record.get", {"recordingId": "record-a"}, context="target"))
        self.assertEqual([page["items"][0] for page in pages], [
            {"frameId": "frame-1", "timestamp": "1700000000001"},
            {"frameId": "frame-2", "timestamp": "1700000000002"},
        ])
        self.assertEqual(decode_base64("AQID"), b"\x01\x02\x03")
        with self.assertRaises(OrbitRpcError) as raised:
            client.invoke("orbit.expression.evaluate", {"expression": "missing_symbol"}, context="target")
        self.assertEqual(raised.exception.code, -32015)
        self.assertEqual(raised.exception.data, {"errorCode": "InvalidRequest", "retryable": False})
        self.assertEqual(self.api.requests, [
            FIXTURES["handshake"],
            FIXTURES["sessionSnapshot"],
            FIXTURES["operationGet"],
            FIXTURES["pollSessionSnapshot"],
            FIXTURES["recordGetPage1"],
            FIXTURES["recordGetPage2"],
            FIXTURES["rpcError"],
        ])
    def test_surfaces_server_error_body_for_non_envelope_failures(self):
        client = OrbitClient({**endpoint(self.api.port), "token": "token-b"})
        with self.assertRaises(OrbitClientError) as raised:
            client.handshake(client={"name": "fixture-client"}, requested_scopes=["read"])
        self.assertIn("HTTP 401: Unauthorized", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
