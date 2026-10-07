"""0.2 adapter behaviour: tool registration, change events, free unchanged polls and file import."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("jot_test_dashboard_v02", ROOT / "dashboard/plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
backend = api._backend


def load_plugin_package():
    """Import the plugin's __init__.py as a package, the way Hermes loads it."""
    name = f"jot_test_plugin_{uuid.uuid4().hex}"
    package_spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    package = importlib.util.module_from_spec(package_spec)
    sys.modules[name] = package
    package_spec.loader.exec_module(package)
    return package, sys.modules[f"{name}.backend"]


def doc(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


class FakeContext:
    def __init__(self):
        self.tools, self.commands, self.hooks = [], [], []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))

    def register_command(self, *args, **kwargs):
        self.commands.append((args, kwargs))


class Events:
    """Stands in for hermes_cli.plugin_events while a test runs."""

    def __init__(self, test, error=None):
        self.calls, self.error = [], error
        events = types.ModuleType("hermes_cli.plugin_events")
        events.broadcast_plugin_event = self.broadcast
        package = types.ModuleType("hermes_cli")
        package.plugin_events = events
        patcher = patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.plugin_events": events})
        patcher.start()
        test.addCleanup(patcher.stop)

    def broadcast(self, plugin_id, event, payload=None):
        self.calls.append((plugin_id, event, payload))
        if self.error:
            raise self.error


class Base(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="jot-v02-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        patcher = patch.object(backend, "data_directory", lambda: self.directory)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Never reach a real Hermes gateway from tests.
        self.events = Events(self)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/jot")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def post_rpc(self, path, method="GET", body=None, etag=None):
        payload = {"path": path, "method": method}
        if body is not None:
            payload["body"] = body
        if etag is not None:
            payload["etag"] = etag
        response = self.client.post("/api/plugins/jot/rpc", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def enable_agent(self, enabled=True):
        self.assertEqual(self.post_rpc("/settings", "PATCH", {"agentEnabled": enabled})["data"]["agentEnabled"], enabled)


class Registration(Base):
    def register(self, ctx=None):
        package, package_backend = load_plugin_package()
        ctx = ctx or FakeContext()
        package.register(ctx)
        patcher = patch.object(package_backend, "data_directory", lambda: self.directory)
        patcher.start()
        self.addCleanup(patcher.stop)
        return ctx

    def test_all_six_tools_stay_visible_and_the_switch_is_enforced_when_called(self):
        # Hermes freezes a chat's tools when it starts; hiding them would make turning
        # collaboration on reach only new chats. The engine refuses calls while it is off.
        ctx = self.register()
        names = [tool["name"] for tool in ctx.tools]
        self.assertEqual(names, ["jot_list", "jot_read", "jot_create", "jot_update", "jot_set_task", "jot_delete"])
        schemas = json.loads((ROOT / "runtime/tools.json").read_text(encoding="utf-8"))
        self.assertEqual([tool["schema"] for tool in ctx.tools], schemas)
        self.assertTrue(all(tool["toolset"] == "jot" and "check_fn" not in tool for tool in ctx.tools))
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(ctx.commands[0][0][0], "jot")
        handlers = {tool["name"]: tool["handler"] for tool in ctx.tools}
        refused = json.loads(handlers["jot_list"]({}))
        self.assertEqual(refused["error"]["code"], "AGENT_DISABLED")
        self.assertIn("Allow AI collaboration", refused["error"]["message"])
        self.enable_agent()
        self.assertIn("data", json.loads(handlers["jot_list"]({})))

    def test_registered_handler_broadcasts_after_a_mutation(self):
        events = self.events
        ctx = self.register()
        handlers = {tool["name"]: tool["handler"] for tool in ctx.tools}
        self.enable_agent()
        events.calls.clear()
        created = json.loads(handlers["jot_create"]({"title": "agent", "text": "body"}))
        self.assertIn("data", created)
        self.assertEqual(events.calls, [("jot", "notes.changed", {})])
        json.loads(handlers["jot_list"]({}))
        self.assertEqual(len(events.calls), 1)


class ChangeEvents(Base):
    def test_mutating_rpc_broadcasts_and_reads_do_not(self):
        events = self.events
        state = self.post_rpc("/state")
        self.post_rpc("/state", etag=state["headers"]["etag"])
        self.post_rpc("/notes")
        self.assertEqual(events.calls, [])
        created = self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        self.assertEqual(events.calls, [("jot", "notes.changed", {})])
        failed = self.post_rpc(f"/notes/{created['data']['id']}", "PATCH", {"revision": 99, "title": "late", "content": doc("y")})
        self.assertIn("error", failed)
        self.assertEqual(len(events.calls), 1)
        self.assertIn("error", self.post_rpc("/settings", "PATCH", {"agentEnabled": "yes"}))
        self.assertEqual(len(events.calls), 1)
        exported = self.post_rpc("/export", "POST", {"title": "t", "content": doc("x"), "format": "txt"})
        self.assertNotIn("error", exported)
        self.assertEqual(len(events.calls), 1)
        self.enable_agent()
        self.assertEqual(len(events.calls), 2)

    def test_attachment_upload_does_not_broadcast(self):
        events = self.events
        uploaded = self.client.post("/api/plugins/jot/attachments", files={"file": ("a.txt", b"text", "text/plain")})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertIn("data", uploaded.json())
        self.assertEqual(events.calls, [])

    def test_mutating_tools_broadcast_only_on_success(self):
        events = self.events
        self.assertIn("error", json.loads(backend.agent_call("jot_create", {"title": "denied", "text": "x"})))
        self.assertEqual(events.calls, [])
        self.enable_agent()
        events.calls.clear()
        note = json.loads(backend.agent_call("jot_create", {"title": "a", "text": "x"}))["data"]
        self.assertEqual(events.calls, [("jot", "notes.changed", {})])
        read = json.loads(backend.agent_call("jot_read", {"id": note["id"]}))["data"]
        json.loads(backend.agent_call("jot_list", {}))
        self.assertEqual(len(events.calls), 1)
        self.assertIn("error", json.loads(backend.agent_call("jot_update", {"id": note["id"], "revision": 99, "appendText": "x"})))
        self.assertEqual(len(events.calls), 1)
        json.loads(backend.agent_call("jot_update", {"id": note["id"], "revision": read["revision"], "appendText": "- [ ] t"}))
        self.assertEqual(len(events.calls), 2)
        json.loads(backend.agent_call("jot_set_task", {"id": note["id"], "revision": read["revision"] + 1, "index": 1, "checked": True}))
        self.assertEqual(len(events.calls), 3)
        deleted = json.loads(backend.agent_call("jot_delete", {"id": note["id"], "revision": read["revision"] + 2}))
        self.assertNotIn("error", deleted)
        self.assertEqual(len(events.calls), 4)

    def test_broadcast_failures_never_fail_the_operation(self):
        Events(self, error=RuntimeError("gateway down"))
        created = self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        self.assertEqual(created["status"], 201)
        with patch.dict(sys.modules, {"hermes_cli": None, "hermes_cli.plugin_events": None}):
            backend.notify_changed()
            self.assertEqual(self.post_rpc("/notes", "POST", {"title": "u", "content": doc("y")})["status"], 201)


class UnchangedPolls(Base):
    def engine_state(self, etag=None):
        """GET /state answered by the real engine, bypassing the Python short-circuit."""
        with patch.object(backend, "state_etag", return_value=None):
            return self.post_rpc("/state", etag=etag)

    def test_python_tag_matches_the_engine_tag(self):
        self.assertIsNone(backend.state_etag(self.directory))  # no jot.json yet: the engine decides
        note = self.post_rpc("/notes", "POST", {"title": "中文", "content": doc("emoji 🎉 and text")})["data"]
        real = self.engine_state()
        self.assertTrue(real["headers"]["etag"].endswith('.none"'))
        self.assertEqual(backend.state_etag(self.directory), real["headers"]["etag"])
        self.enable_agent()
        update = json.loads(backend.agent_call("jot_update", {"id": note["id"], "revision": 1, "appendText": "agent line"}))
        self.assertNotIn("error", update)
        self.assertTrue((self.directory / "jot.activity.json").is_file())
        real = self.engine_state()
        self.assertFalse(real["headers"]["etag"].endswith('.none"'))
        self.assertEqual(real["data"]["agentEdits"][note["id"]]["revision"], 2)
        self.assertEqual(backend.state_etag(self.directory), real["headers"]["etag"])
        self.assertEqual(backend.state_etag(), real["headers"]["etag"])

    def test_unchanged_poll_does_not_start_node_and_matches_the_engine_304(self):
        self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        tag = self.engine_state()["headers"]["etag"]
        engine_304 = self.engine_state(tag)
        self.assertEqual(engine_304["status"], 304)
        with patch.object(backend.subprocess, "run", side_effect=AssertionError("Node started")):
            self.assertEqual(self.post_rpc("/state", etag=tag), engine_304)
            response = self.client.post("/api/plugins/jot/rpc", json={"path": "/state", "etag": tag})
            self.assertEqual(response.json(), engine_304)

    def test_changes_and_other_requests_reach_the_engine(self):
        created = self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})["data"]
        tag = self.post_rpc("/state")["headers"]["etag"]
        self.post_rpc(f"/notes/{created['id']}", "PATCH", {"revision": 1, "title": "changed", "content": doc("y")})
        real_run = backend.subprocess.run
        with patch.object(backend.subprocess, "run", side_effect=real_run) as run:
            fresh = self.post_rpc("/state", etag=tag)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(fresh["status"], 200)
            self.assertEqual(fresh["data"]["notes"][0]["title"], "changed")
            self.assertNotEqual(fresh["headers"]["etag"], tag)
            for payload in [{"path": "/state", "etag": ""}, {"path": "/state"}, {"path": "/state?x=1", "etag": fresh["headers"]["etag"]},
                            {"path": "/notes", "etag": fresh["headers"]["etag"]},
                            {"path": "/state", "method": "HEAD", "etag": fresh["headers"]["etag"]}]:
                with self.subTest(payload=payload):
                    before = run.call_count
                    self.client.post("/api/plugins/jot/rpc", json=payload)
                    self.assertEqual(run.call_count, before + 1)
        # A changed activity sidecar alone also changes the tag.
        self.enable_agent()
        tag = self.post_rpc("/state")["headers"]["etag"]
        (self.directory / "jot.activity.json").write_text('{"version":1,"notes":{}}', encoding="utf-8")
        with patch.object(backend.subprocess, "run", side_effect=real_run) as run:
            self.assertEqual(self.post_rpc("/state", etag=tag)["status"], 200)
            self.assertEqual(run.call_count, 1)

    def test_only_strict_bounded_regular_files_short_circuit(self):
        self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        activity = self.directory / "jot.activity.json"
        activity.write_bytes(b'{"version":1,"notes":{"\xff":1}}')
        self.assertIsNone(backend.state_etag(self.directory))
        activity.unlink()
        activity.mkdir()
        self.assertEqual(backend.state_etag(self.directory), self.engine_state()["headers"]["etag"])
        self.assertTrue(backend.state_etag(self.directory).endswith('.none"'))
        activity.rmdir()
        activity.write_text('{"version":1,"notes":{}}' + " " * backend.MAX_ACTIVITY_BYTES, encoding="utf-8")
        self.assertTrue(backend.state_etag(self.directory).endswith('.none"'))
        self.assertEqual(backend.state_etag(self.directory), self.engine_state()["headers"]["etag"])
        with patch.object(backend, "MAX_STATE_BYTES", 4):
            self.assertIsNone(backend.state_etag(self.directory))
        state = self.directory / "jot.json"
        original = state.read_bytes()
        state.write_bytes(original.replace(b'"t"', b'"\xff"', 1))
        self.assertIsNone(backend.state_etag(self.directory))
        state.unlink()
        self.assertIsNone(backend.state_etag(self.directory))

    def test_errors_fall_through_to_the_engine(self):
        self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        tag = self.post_rpc("/state")["headers"]["etag"]
        with patch.object(backend, "state_etag", side_effect=RuntimeError("boom")):
            self.assertEqual(self.post_rpc("/state", etag=tag)["status"], 304)

    def test_windows_hosts_always_ask_the_engine(self):
        # An unlocked Windows read handle would block the engine's atomic rename of jot.json.
        self.post_rpc("/notes", "POST", {"title": "t", "content": doc("x")})
        tag = self.post_rpc("/state")["headers"]["etag"]
        with patch.object(backend, "UNLOCKED_READS", False):
            self.assertIsNone(backend.state_etag(self.directory))
            with patch.object(subprocess, "run", side_effect=AssertionError("engine")) as run:
                with self.assertRaises(AssertionError):
                    self.client.post("/api/plugins/jot/rpc", json={"path": "/state", "method": "GET", "etag": tag})
            self.assertTrue(run.called)


class Import(Base):
    def setUp(self):
        super().setUp()
        self.seen = []

    def engine(self, response):
        self.response = response
        def fake(payload, **kwargs):
            path = Path(payload["path"])
            info = path.stat()
            self.seen.append({"payload": payload, "kwargs": kwargs, "content": path.read_bytes(),
                              "mode": stat.S_IMODE(info.st_mode), "dir_mode": stat.S_IMODE(path.parent.stat().st_mode)})
            if isinstance(self.response, Exception):
                raise self.response
            return self.response
        patcher = patch.object(api, "invoke", side_effect=fake)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def upload(self, filename, content=b"# Title\n\nBody", folder=None):
        params = {} if folder is None else {"folderId": folder}
        return self.client.post("/api/plugins/jot/import", params=params, files={"file": (filename, content, "text/markdown")})

    def imports(self):
        directory = self.directory / "imports"
        return sorted(directory.iterdir()) if directory.exists() else []

    def test_success_passes_the_exact_payload_and_cleans_up(self):
        result = {"data": {"notes": 1, "attachments": 0, "folders": 0, "noteIds": ["n"], "skipped": []}}
        engine = self.engine(result)
        response = self.upload("My Notes.MD", folder="folder_1")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), result)
        self.assertEqual(engine.call_count, 1)
        seen = self.seen[0]
        path = Path(seen["payload"]["path"])
        self.assertEqual(seen["payload"], {"kind": "import", "path": str(path), "filename": "My Notes.MD", "folderId": "folder_1"})
        self.assertEqual(seen["kwargs"], {"timeout": 300})
        self.assertTrue(path.is_absolute())
        self.assertEqual(path.parent, (self.directory / "imports").resolve())
        self.assertRegex(path.name, r"^[0-9a-f-]{36}\.md$")
        self.assertEqual(str(uuid.UUID(path.stem)), path.stem)
        self.assertEqual(seen["content"], b"# Title\n\nBody")
        if os.name == "posix":
            self.assertEqual(seen["mode"], 0o600)
            self.assertEqual(seen["dir_mode"], 0o700)
        self.assertFalse(path.exists())
        self.assertEqual(self.imports(), [])
        self.assertEqual(self.events.calls, [("jot", "notes.changed", {})])

    def test_folder_and_filename_normalization(self):
        self.engine({"data": {"notes": 0, "attachments": 0, "folders": 0, "noteIds": [], "skipped": []}})
        for name, folder, expected_name, expected_folder, suffix in [
            ("notes.txt", "", "notes.txt", None, "txt"),
            ("archive.ZIP", None, "archive.ZIP", None, "zip"),
            ("dir/sub\\deep.markdown", "a-B_9", "deep.markdown", "a-B_9", "markdown"),
        ]:
            with self.subTest(name=name):
                self.assertEqual(self.upload(name, folder=folder).status_code, 200)
                payload = self.seen[-1]["payload"]
                self.assertEqual(payload["filename"], expected_name)
                self.assertEqual(payload["folderId"], expected_folder)
                self.assertTrue(payload["path"].endswith("." + suffix))
        self.assertEqual(self.imports(), [])

    def test_rejects_unsupported_files_and_folders_before_writing(self):
        engine = self.engine({"data": {}})
        for name, folder in [("notes.pdf", None), ("notes", None), ("md", None), (".md.exe", None), ("notes.md", "../x"),
                             ("notes.md", "a" * 101), ("notes.md", "bad\n"), ("notes.md", "a b")]:
            with self.subTest(name=name, folder=folder):
                response = self.upload(name, folder=folder)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
        engine.assert_not_called()
        self.assertFalse((self.directory / "imports").exists())
        self.assertEqual(self.events.calls, [])

    def test_oversized_upload_is_refused_and_removed(self):
        engine = self.engine({"data": {}})
        with patch.object(backend, "MAX_IMPORT_BYTES", 10):
            response = self.upload("big.md", b"x" * 11)
            self.assertEqual(response.status_code, 413, response.text)
            self.assertEqual(response.json()["error"]["code"], "IMPORT_TOO_LARGE")
            self.assertEqual(self.upload("fits.md", b"x" * 10).status_code, 200)
        self.assertEqual(engine.call_count, 1)
        self.assertEqual(self.imports(), [])

    def test_engine_errors_delete_the_file_and_do_not_broadcast(self):
        self.engine({"error": {"code": "INVALID_INPUT", "message": "bad zip"}, "status": 400})
        response = self.upload("broken.zip", b"PK\x03\x04")
        self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
        self.assertFalse(Path(self.seen[-1]["payload"]["path"]).exists())
        self.response = backend.JotError("REQUEST_TIMEOUT", "slow", 504)
        response = self.upload("slow.md")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["error"]["code"], "REQUEST_TIMEOUT")
        self.assertFalse(Path(self.seen[-1]["payload"]["path"]).exists())
        self.assertEqual(self.imports(), [])
        self.assertEqual(self.events.calls, [])

    def test_stale_temporary_files_are_removed(self):
        self.engine({"data": {}})
        imports = self.directory / "imports"
        imports.mkdir(parents=True)
        stale, fresh, other = imports / f"{uuid.uuid4()}.md", imports / f"{uuid.uuid4()}.zip", imports / "keep.md"
        for file in (stale, fresh, other):
            file.write_bytes(b"x")
        old = time.time() - 25 * 60 * 60
        os.utime(stale, (old, old))
        os.utime(other, (old, old))
        self.assertEqual(self.upload("a.md").status_code, 200)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(other.exists())

    def test_real_engine_receives_a_file_it_may_read(self):
        # The engine's import kind belongs to another track; whatever it answers, the adapter cleans up.
        response = self.upload("real.md", b"# Real\n\nimported")
        self.assertIn(response.status_code, (200, 400, 404, 413, 500))
        self.assertEqual(self.imports(), [])


class Invoke(unittest.TestCase):
    def test_timeout_defaults_to_90_and_can_be_raised(self):
        completed = types.SimpleNamespace(stdout=b'{"data": null}')
        with patch.object(backend.subprocess, "run", return_value=completed) as run:
            backend.invoke({"kind": "tool"}, directory=Path(tempfile.gettempdir()))
            self.assertEqual(run.call_args.kwargs["timeout"], 90)
            backend.invoke({"kind": "import"}, directory=Path(tempfile.gettempdir()), timeout=300)
            self.assertEqual(run.call_args.kwargs["timeout"], 300)


if __name__ == "__main__":
    unittest.main()
