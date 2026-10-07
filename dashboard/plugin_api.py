"""Authenticated, profile-scoped Desktop API under /api/plugins/jot."""
import asyncio
import base64
import json
import importlib.util
import re
from pathlib import Path
from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse

# Hermes imports dashboard APIs as a flat module, independently of register().
# Load our own sibling only; no global sys.path changes or Hermes internals.
_spec = importlib.util.spec_from_file_location("jot_dashboard_backend", Path(__file__).resolve().parent.parent / "backend.py")
if _spec is None or _spec.loader is None:
    raise ImportError("The Jot backend is missing.")
_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_backend)
JotError, invoke, ROOT = _backend.JotError, _backend.invoke, _backend.ROOT

_native_spec = importlib.util.spec_from_file_location("jot_native_open", ROOT / "native_open.py")
if _native_spec is None or _native_spec.loader is None:
    raise ImportError("The Jot attachment helper is missing.")
_native = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(_native)

router = APIRouter()


@router.get("/health")
async def health():
    return {"ready": (ROOT / "runtime/worker.cjs").is_file() and (ROOT / "runtime/editor.html").is_file()}


@router.get("/editor")
async def editor():
    # The locally bundled, SHA-pinned editor executes only in SDK SandboxedFrame's opaque realm.
    content = await asyncio.to_thread((ROOT / "runtime/editor.html").read_bytes)
    return {"src": "data:text/html;base64," + base64.b64encode(content).decode("ascii")}


async def operation(payload: dict):
    try:
        # to_thread preserves Hermes' active profile contextvars.
        return await asyncio.to_thread(invoke, payload)
    except JotError as error:
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, status_code=error.status)


# POST routes that only read notes; every other non-GET request may change them.
_READ_ONLY_POSTS = frozenset({"/export", "/export-library", "/attachments"})


def _route(path: str) -> str:
    return path.split("?", 1)[0].split("#", 1)[0]


async def _unchanged_state(etag: str):
    """The engine's exact 304 result for an unchanged library, computed without starting Node.

    Atomic renames make unlocked reads safe: a racing write yields a different tag and falls through.
    """
    try:
        tag = await asyncio.to_thread(_backend.state_etag)
    except Exception:
        return None
    if tag is None or tag != etag:
        return None
    return {"status": 304, "headers": {"etag": tag, "cache-control": "no-store", "x-content-type-options": "nosniff"}}


@router.post("/rpc")
async def rpc(request: Request):
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 2 * 1024 * 1024:
            return JSONResponse({"error": {"code": "REQUEST_TOO_LARGE", "message": "The document is too large."}}, status_code=413)
        chunks.append(chunk)
    raw = b"".join(chunks)
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Expected JSON."}}, status_code=400)
    if not isinstance(body, dict) or set(body) - {"method", "path", "body", "etag"}:
        return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Invalid note request."}}, status_code=400)
    method, path, etag = body.get("method", "GET"), body.get("path"), body.get("etag", "")
    if method == "GET" and path == "/state" and body.get("body") is None and isinstance(etag, str) and etag:
        unchanged = await _unchanged_state(etag)
        if unchanged is not None:
            return unchanged
    result = await operation({"kind": "http", "method": method, "path": path,
                              "body": body.get("body"), "headers": {"if-none-match": etag}})
    if method not in ("GET", "HEAD") and isinstance(path, str) and _route(path) not in _READ_ONLY_POSTS \
            and _backend.succeeded(result):
        _backend.notify_changed()
    return result


@router.post("/attachments")
async def upload(file: UploadFile = File(...)):
    content = await file.read(20 * 1024 * 1024 + 1)
    if len(content) > 20 * 1024 * 1024:
        return JSONResponse({"error": {"code": "ATTACHMENT_TOO_LARGE", "message": "Each attachment is limited to 20 MiB."}}, status_code=413)
    from urllib.parse import quote
    return await operation({"kind": "http", "method": "POST", "path": "/attachments",
                            "base64": base64.b64encode(content).decode("ascii"),
                            "headers": {"x-jot-filename": quote(file.filename or "attachment", safe=""),
                                        "x-jot-mime-type": file.content_type or "application/octet-stream"}})


@router.post("/import")
async def import_notes(file: UploadFile = File(...), folderId: str | None = None):
    filename = re.split(r"[\\/]", file.filename or "")[-1]
    extension = _backend.import_extension(filename)
    if extension is None:
        return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Import a .md, .markdown, .txt or .zip file."}}, status_code=400)
    folder = folderId or None
    if folder is not None and not _backend.valid_id(folder):
        return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Invalid folder."}}, status_code=400)
    staged = None
    try:
        # to_thread preserves Hermes' active profile contextvars and keeps the copy off the event loop.
        staged = await asyncio.to_thread(_backend.stage_import, file.file, extension)
        result = await asyncio.to_thread(invoke, {"kind": "import", "path": str(staged), "filename": filename, "folderId": folder},
                                         timeout=_backend.IMPORT_TIMEOUT)
    except JotError as error:
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, status_code=error.status)
    except OSError:
        return JSONResponse({"error": {"code": "PERSISTENCE_ERROR", "message": "Could not prepare the import."}}, status_code=500)
    finally:
        # Synchronous: a cancelled request must not skip the cleanup at another await.
        if staged is not None:
            _backend.remove_quietly(staged)
    if _backend.succeeded(result):
        _backend.notify_changed()
    return result


@router.get("/attachments/{attachment_id}/preview")
async def preview(attachment_id: str):
    return await operation({"kind": "attachment-preview", "id": attachment_id})


@router.get("/attachments/{attachment_id}/inline")
async def inline(attachment_id: str):
    return await operation({"kind": "attachment-inline", "id": attachment_id})


@router.get("/attachment-capabilities")
async def capabilities():
    return {"nativeOpen": _native.can_open()}


@router.post("/attachments/{attachment_id}/open")
async def open_attachment(attachment_id: str, request: Request):
    # The client supplies an ID, never a file path or shell command.
    raw = b""
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 64:
            return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Opening requires only the attachment identifier."}}, status_code=400)
        raw += chunk
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        body = None
    if body != {}:
        return JSONResponse({"error": {"code": "INVALID_INPUT", "message": "Opening requires only the attachment identifier."}}, status_code=400)
    prepared = await operation({"kind": "attachment-preview", "id": attachment_id})
    if not isinstance(prepared, dict) or "error" in prepared:
        return prepared
    if await request.is_disconnected():
        return JSONResponse({"error": {"code": "ATTACHMENT_OPEN_CANCELLED", "message": "The request was cancelled."}}, status_code=409)
    try:
        await asyncio.to_thread(_native.open_copy, prepared["data"]["path"])
    except _native.NativeOpenError as error:
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, status_code=error.status)
    return {"data": None}
