"""Smoke-test the distributable outside the checkout, with no development dependencies."""
from pathlib import Path
import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
# Hermes' plugin scanner flags these as hidden-text injection; packaged text writes them as escapes instead.
INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes", action="store_true", help="Also require the installed Hermes validator")
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    archive = ROOT / "artifacts" / f"hermes-jot-{version}-local.zip"
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
        for member in sorted(package.rglob("*")):
            try:
                text = member.read_bytes().decode("utf-8") if member.is_file() else ""
            except UnicodeDecodeError:
                continue
            hidden = INVISIBLE.search(text)
            if hidden:
                raise SystemExit("Invisible or bidirectional Unicode U+%04X in packaged %s, line %d; write it as an escape."
                                 % (ord(hidden.group()), member.relative_to(package).as_posix(), text.count("\n", 0, hidden.start()) + 1))
        # Export and import code loads lazily from library.cjs; the per-request engine stays small.
        if not (package / "runtime/library.cjs").is_file() or b"pdfkit" in (package / "runtime/worker.cjs").read_bytes():
            raise SystemExit("The packaged engine must keep export code in runtime/library.cjs.")
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
                                    text=True, encoding="utf-8", capture_output=True, timeout=120)
            (ROOT / "artifacts/final-extracted-validation.json").write_text(result.stdout, encoding="utf-8")
            if result.returncode or not json.loads(result.stdout).get("ok"):
                raise SystemExit("Extracted package failed Hermes validation; see artifacts/final-extracted-validation.json.")
            summary["hermesValidation"] = True
        env = {key: value for key, value in os.environ.items() if key in
               {"PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot", "WINDIR"}}

        def request(payload):
            result = subprocess.run([node, str(package / "runtime/worker.cjs"), str(parent / "note-data")],
                                    cwd=parent, env=env, input=json.dumps(payload), text=True, encoding="utf-8",
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
        imports = parent / "note-data" / "imports"
        imports.mkdir(mode=0o700, exist_ok=True)

        def import_file(name, data):
            path = imports / f"{uuid.uuid4()}{Path(name).suffix.lower()}"
            path.write_bytes(data)
            try:
                return request({"kind": "import", "path": str(path), "filename": name, "folderId": None})["data"]
            finally:
                path.unlink()

        markdown = import_file("导入.md", "# 导入的笔记\n\n- [x] 完成\n\n| 列 | 值 |\n| --- | --- |\n| 中文 | 1 |\n".encode("utf-8"))
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwS8AAAAASUVORK5CYII=")
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as vault:
            vault.writestr("项目/计划.md", "# 计划\n\n![草图](img/草图.png)\n".encode("utf-8"))
            vault.writestr("项目/img/草图.png", png)
            vault.writestr("根目录.txt", "纯文本".encode("utf-8"))
        archive_result = import_file("vault.zip", bundle.getvalue())
        if (markdown["notes"], archive_result["notes"], archive_result["attachments"], archive_result["folders"]) != (1, 2, 1, 1) \
                or markdown["skipped"] or archive_result["skipped"]:
            raise SystemExit("Packaged engine import failed: " + json.dumps([markdown, archive_result], ensure_ascii=False))
        state = request({"kind": "http", "path": "/state", "method": "GET"})["data"]
        titles = {item["title"]: item for item in state["notes"]}
        if titles.get("导入的笔记", {}).get("content", {}).get("content", [{}])[0].get("type") != "taskList" \
                or titles.get("计划", {}).get("content", {}).get("content", [{}])[0].get("type") != "image" or "根目录" not in titles:
            raise SystemExit("Packaged engine imported unexpected notes.")
        summary.update({"standaloneEngine": True, "documentationLinks": True, "exports": exports, "imports": True, "files": len(names)})
    (ROOT / "artifacts/final-package-audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print("PASS isolated package: Chinese rich note, TXT/Markdown/PDF/DOCX exports and Markdown/ZIP imports" +
          (", plus Hermes validation." if args.hermes else "."))


if __name__ == "__main__":
    main()
