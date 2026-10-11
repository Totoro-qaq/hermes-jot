"""Profile-scoped bridge to Jot's bundled, port-free note engine."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent
MAX_REQUEST = 30 * 1024 * 1024
# Mirrors src/store.ts: file names, size limits and the content tag behind /state ETags.
STATE_FILENAME = "jot.json"
ACTIVITY_FILENAME = "jot.activity.json"
MAX_STATE_BYTES = 32 * 1024 * 1024
MAX_ACTIVITY_BYTES = 2 * 1024 * 1024
MUTATING_TOOLS = frozenset({"jot_create", "jot_update", "jot_set_task", "jot_delete"})
IMPORT_EXTENSIONS = frozenset({"md", "markdown", "txt", "zip"})
MAX_IMPORT_BYTES = 100 * 1024 * 1024
IMPORT_TIMEOUT = 300
_IMPORT_NAME = re.compile(r"[0-9a-f-]{36}\.(?:md|markdown|txt|zip)")
_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")
# O_NONBLOCK keeps a FIFO planted at a data path from stalling the caller.
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)


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


def invoke(payload: dict, *, directory: Path | None = None, timeout: float = 90) -> dict:
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
                                input=encoded, capture_output=True, env=env, timeout=timeout, check=False)
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


def succeeded(response: object) -> bool:
    return isinstance(response, dict) and "error" not in response


def notify_changed() -> None:
    """Tell connected Hermes clients that notes changed. Best effort: never fails the saved operation."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event("jot", "notes.changed", {})
    except Exception:
        pass


def agent_call(name: str, arguments: dict) -> str:
    try:
        response = invoke({"kind": "tool", "name": name, "args": arguments})
    except JotError as error:
        return json.dumps({"error": {"code": error.code, "message": str(error)}}, ensure_ascii=False)
    if name in MUTATING_TOOLS and succeeded(response):
        notify_changed()
    return json.dumps(response, ensure_ascii=False)


def _open_regular(path: Path):
    """Open a regular file for reading; (None, stat) when the path is anything else."""
    descriptor = os.open(path, _READ_FLAGS)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            os.close(descriptor)
            return None, info
        return os.fdopen(descriptor, "rb"), info
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise


def _read_limited(path: Path, limit: int) -> bytes | None:
    """A regular file's bytes, or None when it is not a regular file or exceeds limit. OSError propagates."""
    handle, info = _open_regular(path)
    if handle is None:
        return None
    with handle:
        if info.st_size > limit:
            return None
        source = handle.read(limit + 1)
    return None if len(source) > limit else source


def content_tag(source: bytes) -> str:
    """src/store.ts contentTag: the first 22 characters of base64url(sha256(utf-8 source))."""
    return base64.urlsafe_b64encode(hashlib.sha256(source).digest()).decode("ascii")[:22]


def _strict_utf8(source: bytes) -> bool:
    try:
        source.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


# Windows opens files without FILE_SHARE_DELETE, so an unlocked read here could make the engine's
# atomic rename of jot.json fail mid-save. Only POSIX hosts answer unchanged polls without Node.
UNLOCKED_READS = os.name != "nt"


def state_etag(directory: Path | None = None) -> str | None:
    """The ETag the engine's GET /state would return now, or None when only the engine can decide.

    Node decodes both files as UTF-8 before hashing, so only strictly valid UTF-8 hashes to the same
    tag here; anything else, and any problem with jot.json, defers to the engine.
    """
    if not UNLOCKED_READS:
        return None
    root = Path(directory if directory is not None else data_directory()).resolve()
    try:
        state = _read_limited(root / STATE_FILENAME, MAX_STATE_BYTES)
    except OSError:
        return None
    if state is None or not _strict_utf8(state):
        return None
    try:
        activity = _read_limited(root / ACTIVITY_FILENAME, MAX_ACTIVITY_BYTES)
    except OSError:
        activity = None
    if activity is None:
        activity_tag = "none"
    elif _strict_utf8(activity):
        activity_tag = content_tag(activity)
    else:
        return None
    return f'"{content_tag(state)}.{activity_tag}"'


def import_extension(filename: str) -> str | None:
    """The normalized extension of an importable file name, or None."""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return suffix if suffix in IMPORT_EXTENSIONS else None


def valid_id(value: str) -> bool:
    return _ID.fullmatch(value) is not None


def remove_quietly(path: Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def stage_import(source, extension: str, directory: Path | None = None) -> Path:
    """Copy a readable binary stream to <data>/imports/<uuid4>.<ext> (0600). The caller deletes it."""
    root = Path(directory if directory is not None else data_directory()).resolve()
    imports = root / "imports"
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.makedirs(imports, mode=0o700, exist_ok=True)
    try:
        os.chmod(imports, 0o700)
    except OSError:
        pass
    # Only this adapter's UUID files are temporary; an interrupted import never lingers past a day.
    cutoff = time.time() - 24 * 60 * 60
    try:
        with os.scandir(imports) as entries:
            for entry in entries:
                try:
                    if _IMPORT_NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False) \
                            and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                        os.unlink(entry.path)
                except OSError:
                    pass
    except OSError:
        pass
    target = imports / f"{uuid.uuid4()}.{extension}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            size = 0
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_IMPORT_BYTES:
                    raise JotError("IMPORT_TOO_LARGE", "Imports are limited to 100 MiB.", 413)
                output.write(chunk)
    except BaseException:
        remove_quietly(target)
        raise
    return target


# Slash commands are dispatched by Hermes before a model turn. This is the same
# PATCH /settings write the Desktop switch uses (actor "user" inside the engine).
HELP = (
    "Jot: /jot shows the AI switch, note count and recent titles outside Hermes Desktop. "
    "/jot, /jot new and /jot capture open Jot in Hermes Desktop. "
    "/jot ai on, /jot ai off and /jot ai status control AI collaboration for this profile. "
    "Only you can change that switch; the agent cannot."
)
AI_USAGE = "Usage: /jot ai on|off|status"
_DESKTOP_OPEN = frozenset({"new", "capture"})
_AI_ACTIONS = frozenset({"on", "off", "status"})
_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def _session_surface() -> tuple[str, str]:
    """Hermes binds the chat surface on the slash-command thread. Empty when it did not."""
    try:
        from gateway.session_context import get_session_env
    except Exception:
        get_session_env = None
    if get_session_env is None:
        return (
            os.environ.get("HERMES_SESSION_SOURCE", "").strip().lower(),
            os.environ.get("HERMES_SESSION_PLATFORM", "").strip().lower(),
        )
    return (
        get_session_env("HERMES_SESSION_SOURCE", "").strip().lower(),
        get_session_env("HERMES_SESSION_PLATFORM", "").strip().lower(),
    )


def desktop_chat() -> bool:
    """True only for Hermes Desktop chat, where composer middleware already opened Jot.

    CLI, TUI, the Desktop terminal (``HERMES_DESKTOP_TERMINAL``) and messaging
    gateways are not that surface, so ``/jot`` has to answer there itself.
    """
    source, platform = _session_surface()
    if source == "desktop" or platform == "desktop":
        return True
    if source or platform:
        return False
    return _truthy(os.environ.get("HERMES_DESKTOP")) and not _truthy(os.environ.get("HERMES_DESKTOP_TERMINAL"))


def _engine(method: str, path: str, body: dict | None = None) -> dict:
    payload: dict = {"kind": "http", "method": method, "path": path}
    if body is not None:
        payload["body"] = body
    response = invoke(payload)
    if not isinstance(response, dict) or not succeeded(response) or not isinstance(response.get("data"), dict):
        error = response.get("error") if isinstance(response, dict) else None
        code = error.get("code") if isinstance(error, dict) and isinstance(error.get("code"), str) else "RUNTIME_ERROR"
        message = error.get("message") if isinstance(error, dict) and isinstance(error.get("message"), str) else "Jot could not read its notes."
        status = response.get("status") if isinstance(response, dict) and isinstance(response.get("status"), int) else 500
        raise JotError(code, message, status)
    return response["data"]


def _note_title(note: dict) -> str:
    title = note.get("title")
    text = " ".join(title.split()) if isinstance(title, str) else ""
    if not text:
        text = "(untitled)"
    if len(text) > 80:
        text = text[:79] + "…"
    return text


def _active_notes(state: dict) -> list[dict]:
    notes = [note for note in state.get("notes") or [] if isinstance(note, dict) and not note.get("deletedAt")]
    # Same order as the note list: pinned, then most recently updated, then id.
    notes.sort(key=lambda note: note.get("id") or "")
    notes.sort(key=lambda note: note.get("updatedAt") or "", reverse=True)
    notes.sort(key=lambda note: 0 if note.get("pinned") else 1)
    return notes


def library_summary(state: dict) -> str:
    enabled = state.get("agentEnabled") is True
    notes = _active_notes(state)
    count = len(notes)
    count_text = "No notes yet." if count == 0 else "1 note." if count == 1 else f"{count} notes."
    lines = [f"Jot: AI collaboration is {'on' if enabled else 'off'}. {count_text}"]
    if notes:
        lines.append("Recent: " + ", ".join(_note_title(note) for note in notes[:5]))
    if not enabled:
        lines.append("Turn it on with /jot ai on, or with Allow AI collaboration in Hermes Desktop.")
    return "\n".join(lines)


def _switch_text(enabled: bool) -> str:
    if enabled:
        return "Jot AI collaboration is on."
    return "Jot AI collaboration is off. Turn it on with /jot ai on, or with Allow AI collaboration in Hermes Desktop."


def _ai_command(tokens: list[str]) -> str:
    if len(tokens) != 1 or tokens[0].lower() not in _AI_ACTIONS:
        return AI_USAGE
    action = tokens[0].lower()
    if action == "status":
        return _switch_text(_engine("GET", "/state").get("agentEnabled") is True)
    enabled = _engine("PATCH", "/settings", {"agentEnabled": action == "on"}).get("agentEnabled") is True
    # The Desktop API announces this write so an open note list picks up the switch.
    notify_changed()
    return _switch_text(enabled)


def handle_command(raw_args: str) -> str | None:
    """``/jot`` for CLI, TUI, gateways and Desktop. Returns None when Desktop owns the draft."""
    try:
        tokens = raw_args.split() if isinstance(raw_args, str) else []
        if len(tokens) == 1 and tokens[0].lower() in {"help", "-h", "--help"}:
            return HELP
        head = tokens[0].lower() if len(tokens) == 1 else ""
        if not tokens or head in _DESKTOP_OPEN:
            # Desktop chat already opened the pane for these. A reply would replace
            # the host's "no output" notice. new/capture have no CLI equivalent.
            if desktop_chat() or head in _DESKTOP_OPEN:
                return None
            return library_summary(_engine("GET", "/state"))
        if tokens and tokens[0].lower() == "ai":
            return _ai_command(tokens[1:])
        return HELP
    except JotError as error:
        return str(error)
