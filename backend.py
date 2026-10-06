"""Profile-scoped bridge to Jot's bundled, port-free note engine."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
MAX_REQUEST = 30 * 1024 * 1024


class JotError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def data_directory() -> Path:
    # This is the documented plugin storage API; resolve on every call, never at import time.
    try:
        from plugins.plugin_storage import plugin_data_dir
    except ImportError as error:
        raise JotError("HOST_VERSION_UNSUPPORTED", "Update Hermes to a build with the documented plugin storage API.", 503) from error
    return plugin_data_dir("jot")


def invoke(payload: dict, *, directory: Path | None = None) -> dict:
    node = shutil.which("node")
    if not node:
        raise JotError("RUNTIME_UNAVAILABLE", "Node.js 22 or newer is required. Prepare Hermes dependencies with hermes pm install.", 503)
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise JotError("INVALID_INPUT", "The request must contain valid JSON and Unicode text.", 400) from error
    if len(encoded) > MAX_REQUEST:
        raise JotError("REQUEST_TOO_LARGE", "The request exceeds Jot's attachment limit.", 413)
    # No shell, no credentials forwarded. The only filesystem root is chosen by the host profile.
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"
    }}
    try:
        result = subprocess.run([node, str(ROOT / "runtime/worker.cjs"), str((directory or data_directory()).resolve())],
                                input=encoded, capture_output=True, env=env, timeout=90, check=False)
    except subprocess.TimeoutExpired as error:
        raise JotError("REQUEST_TIMEOUT", "Jot took too long to finish. Check the current note before retrying.", 504) from error
    except OSError as error:
        raise JotError("RUNTIME_UNAVAILABLE", "The Jot note engine could not start.", 503) from error
    try:
        response = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise JotError("RUNTIME_ERROR", "The Jot note engine returned an invalid response.", 500) from error
    if not isinstance(response, dict):
        raise JotError("RUNTIME_ERROR", "The Jot note engine returned an invalid response.", 500)
    return response


def agent_call(name: str, arguments: dict) -> str:
    try:
        response = invoke({"kind": "tool", "name": name, "args": arguments})
        return json.dumps(response, ensure_ascii=False)
    except JotError as error:
        return json.dumps({"error": {"code": error.code, "message": str(error)}}, ensure_ascii=False)
