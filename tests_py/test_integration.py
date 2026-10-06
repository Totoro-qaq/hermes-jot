"""Real FastAPI + Python bridge + bundled Node engine, with isolated note directories."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("jot_test_dashboard", ROOT / "dashboard/plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
REAL_DATA_DIRECTORY = api._backend.data_directory


def doc(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


class Integration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="jot-integration-")
        self.directory = Path(self.temporary.name)
        api._backend.data_directory = lambda: self.directory
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/jot")
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def rpc(self, path, method="GET", body=None):
        payload = {"path": path, "method": method}
        if body is not None:
            payload["body"] = body
        response = self.client.post("/api/plugins/jot/rpc", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def tool(self, name, **args):
        return api._backend.invoke({"kind": "tool", "name": name, "args": args})

    def test_human_and_agent_revision_undo_and_disabled_boundary(self):
        self.assertFalse(self.rpc("/state")["data"]["agentEnabled"])
        self.assertIn("error", self.tool("jot_list"))
        initial = self.rpc("/notes", "POST", {"title": "共同笔记", "content": doc("用户确认的原文")})["data"]
        self.rpc("/settings", "PATCH", {"agentEnabled": True})
        read = self.tool("jot_read", id=initial["id"])["data"]
        update = self.tool("jot_update", id=initial["id"], revision=read["revision"], appendText="- [ ] 验收")
        self.assertEqual(update["data"]["revision"], 2)
        self.assertEqual(self.tool("jot_update", id=initial["id"], revision=1, appendText="过期")["error"]["code"], "REVISION_CONFLICT")
        tasks = self.tool("jot_read", id=initial["id"])["data"]["tasks"]
        self.assertFalse(tasks[0]["checked"])
        changed = self.tool("jot_set_task", id=initial["id"], revision=2, index=1, checked=True)["data"]
        self.assertTrue(changed["task"]["checked"])
        undone = self.rpc(f"/notes/{initial['id']}/revert-agent-edit", "POST", {"revision": 3})["data"]
        self.assertEqual(undone["text"], "用户确认的原文")
        self.rpc("/settings", "PATCH", {"agentEnabled": False})
        self.assertIn("error", self.tool("jot_create", title="denied", text="denied"))
        self.assertEqual(len(self.rpc("/state")["data"]["notes"]), 1)

    def test_attachment_preview_and_all_export_formats(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=")
        uploaded = self.client.post("/api/plugins/jot/attachments", files={"file": ("示例.png", png, "image/png")}).json()
        attachment = uploaded["data"]
        preview = self.client.get(f"/api/plugins/jot/attachments/{attachment['id']}/preview").json()["data"]
        self.assertEqual(Path(preview["path"]).read_bytes(), png)
        content = doc("中文导出和附件")
        content["content"].append({"type": "image", "attrs": {"attachmentId": attachment["id"], "alt": "示例"}})
        for format in ["txt", "md", "pdf", "docx"]:
            with self.subTest(format=format):
                result = self.rpc("/export", "POST", {"title": "中文笔记", "content": content, "format": format})
                self.assertNotIn("error", result, result)
                file = Path(result["file"]["path"])
                self.assertGreater(file.stat().st_size, 10)
                if format == "pdf":
                    self.assertTrue(file.read_bytes().startswith(b"%PDF"))
                if format in ["md", "docx"]:
                    self.assertTrue(zipfile.is_zipfile(file))

    def test_ui_cannot_choose_worker_operation_or_escape_namespace(self):
        response = self.client.post("/api/plugins/jot/rpc", json={"kind": "tool", "name": "jot_list", "method": "GET", "path": "/state"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", self.rpc("/../config"))
        self.assertIn("error", self.tool("jot_list", unexpected=True))

    def test_files_stay_separate_for_different_profile_data_roots(self):
        a = self.directory / "profile-a"
        b = self.directory / "profile-b"
        api._backend.invoke({"kind": "http", "method": "POST", "path": "/notes", "body": {"title": "private", "content": doc("only A")}}, directory=a)
        state = api._backend.invoke({"kind": "http", "method": "GET", "path": "/state"}, directory=b)
        self.assertEqual(state["data"]["notes"], [])

    def test_real_hermes_profile_context_survives_the_async_worker_hop(self):
        try:
            from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        except ImportError:
            self.skipTest("Run through the Hermes CLI to exercise its real profile context.")
        with patch.object(api._backend, "data_directory", REAL_DATA_DIRECTORY):
            first = self.directory / "profile-a"
            second = self.directory / "profile-b"
            token = set_hermes_home_override(first)
            try:
                created = self.rpc("/notes", "POST", {"title": "Profile A only", "content": doc("A")})
                self.assertEqual(created["status"], 201)
            finally:
                reset_hermes_home_override(token)
            token = set_hermes_home_override(second)
            try:
                self.assertEqual(self.rpc("/state")["data"]["notes"], [])
            finally:
                reset_hermes_home_override(token)
            self.assertTrue((first / "plugin-data/jot/jot.json").exists())

    def test_editor_is_pinned_local_content_with_no_network_or_host_access(self):
        response = self.client.get("/api/plugins/jot/editor")
        self.assertEqual(response.status_code, 200)
        html = base64.b64decode(response.json()["src"].split(",", 1)[1]).decode()
        self.assertIn("connect-src 'none'", html)
        self.assertIn("script-src 'sha256-", html)
        self.assertNotIn("window.hermesDesktop", html)

    def test_native_open_uses_verified_copy_and_refuses_client_paths(self):
        uploaded = self.client.post("/api/plugins/jot/attachments", files={"file": ("notes with spaces.txt", b"Synthetic text", "text/plain")}).json()["data"]
        url = f"/api/plugins/jot/attachments/{uploaded['id']}/open"
        with patch.object(api._native, "open_copy") as opener:
            refused = self.client.post(url, json={"path": "/arbitrary/private/file"})
            self.assertEqual(refused.status_code, 400)
            opener.assert_not_called()
            accepted = self.client.post(url, json={})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            path = Path(opener.call_args.args[0])
            self.assertTrue(path.resolve().is_relative_to(self.directory.resolve()))
            self.assertEqual(path.read_bytes(), b"Synthetic text")

    def test_native_error_does_not_disclose_command_output_or_paths(self):
        with patch.object(api._native, "can_open", return_value=True), patch.object(api._native.subprocess, "run", side_effect=OSError("secret path and command output")), patch.object(api._native.os, "startfile", side_effect=OSError("secret path and command output"), create=True):
            with self.assertRaises(api._native.NativeOpenError) as caught:
                api._native.open_copy(str(self.directory / "example.txt"))
        self.assertNotIn("secret path", str(caught.exception))

    def test_invalid_unicode_fails_before_starting_the_engine(self):
        with patch.object(api._backend.subprocess, "run") as process:
            with self.assertRaises(api._backend.JotError) as caught:
                api._backend.invoke({"kind": "tool", "name": "jot_create", "args": {"title": "bad", "text": "\ud800"}})
        self.assertEqual(caught.exception.code, "INVALID_INPUT")
        process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
