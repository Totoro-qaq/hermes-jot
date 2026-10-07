"""Smoke-test the distributable outside the checkout, with no development dependencies."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes", action="store_true", help="Also require the installed Hermes validator")
    args = parser.parse_args()
    archive = ROOT / "artifacts/hermes-jot-0.1.0-local.zip"
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required.")
    summary = {"archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix="jot-package-check-") as temporary:
        parent = Path(temporary)
        with zipfile.ZipFile(archive) as package_zip:
            names = package_zip.namelist()
            if any(Path(name).is_absolute() or ".." in Path(name).parts for name in names):
                raise SystemExit("Unsafe archive member.")
            package_zip.extractall(parent)
        package = parent / "jot"
        if not (package / "plugin.yaml").is_file():
            raise SystemExit("Expected a complete jot/ package.")
        for document in package.rglob("*.md"):
            for target in re.findall(r"\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
                if "://" in target or target.startswith("#"):
                    continue
                relative = target.split("#")[0]
                if relative and not (document.parent / relative).exists():
                    raise SystemExit("Broken packaged documentation link in " + document.name + ": " + relative)
        if args.hermes:
            hermes = shutil.which("hermes")
            if not hermes:
                raise SystemExit("Hermes CLI is required with --hermes.")
            result = subprocess.run([hermes, "plugins", "validate", str(package), "--install-deps", "--json"],
                                    text=True, capture_output=True, timeout=120)
            (ROOT / "artifacts/final-extracted-validation.json").write_text(result.stdout, encoding="utf-8")
            if result.returncode or not json.loads(result.stdout).get("ok"):
                raise SystemExit("Extracted package failed Hermes validation; see artifacts/final-extracted-validation.json.")
            summary["hermesValidation"] = True
        env = {key: value for key, value in os.environ.items() if key in
               {"PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot", "WINDIR"}}

        def request(payload):
            result = subprocess.run([node, str(package / "runtime/worker.cjs"), str(parent / "note-data")],
                                    cwd=parent, env=env, input=json.dumps(payload), text=True,
                                    capture_output=True, check=True, timeout=60)
            response = json.loads(result.stdout)
            if "error" in response:
                raise RuntimeError(response["error"])
            return response

        example = {"title": "Package check", "content": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Independent package — 中文验收"}]},
            {"type": "table", "content": [{"type": "tableRow", "content": [
                {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "保留表格"}]}]},
            ]}]},
        ]}}
        note = request({"kind": "http", "path": "/notes", "method": "POST", "body": example})["data"]
        if "中文验收" not in note["text"] or "保留表格" not in note["text"]:
            raise SystemExit("Packaged engine lost document content.")
        exports = {}
        for format_name in ("txt", "md", "pdf", "docx"):
            response = request({"kind": "http", "path": "/export", "method": "POST",
                                "body": {**example, "format": format_name}})
            path = Path(response["file"]["path"])
            content = path.read_bytes()
            if not content or format_name == "pdf" and not content.startswith(b"%PDF-"):
                raise SystemExit("Invalid packaged export: " + format_name)
            if format_name == "docx":
                with zipfile.ZipFile(path) as document:
                    if "word/document.xml" not in document.namelist():
                        raise SystemExit("Invalid Word archive.")
            exports[format_name] = len(content)
        summary.update({"standaloneEngine": True, "documentationLinks": True, "exports": exports, "files": len(names)})
    (ROOT / "artifacts/final-package-audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print("PASS isolated package: Chinese rich note and TXT/Markdown/PDF/DOCX exports" +
          (", plus Hermes validation." if args.hermes else "."))


if __name__ == "__main__":
    main()
