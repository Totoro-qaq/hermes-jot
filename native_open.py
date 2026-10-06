"""Open an attachment copy only on an explicit Desktop gesture, never an agent tool."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

class NativeOpenError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code, self.status = code, status


def can_open() -> bool:
    if sys.platform == "darwin":
        return bool(shutil.which("open"))
    if sys.platform == "win32":
        return hasattr(os, "startfile")
    return bool((os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and shutil.which("xdg-open"))


def open_copy(path: str) -> None:
    if not can_open():
        raise NativeOpenError("ATTACHMENT_OPEN_UNAVAILABLE", "This host cannot open applications. Download the attachment instead.", 409)
    try:
        if sys.platform == "win32":
            os.startfile(str(Path(path).resolve()))
        else:
            command = [shutil.which("open"), "--", path] if sys.platform == "darwin" else [shutil.which("xdg-open"), path]
            subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=15, check=True)
    except subprocess.TimeoutExpired as error:
        raise NativeOpenError("ATTACHMENT_OPEN_TIMEOUT", "The default application did not respond in time.", 504) from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise NativeOpenError("ATTACHMENT_OPEN_FAILED", "Could not open the attachment. Check its default application or download it.", 502) from error
