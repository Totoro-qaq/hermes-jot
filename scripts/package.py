"""Create a local review/install archive with an explicit content allow-list."""
from pathlib import Path
import hashlib
import json
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_DIRS = ["src", "runtime", "desktop", "dashboard", "assets", "LICENSES", "tests", "tests_py", "scripts", "dev"]
ALLOWED_FILES = ["__init__.py", "backend.py", "native_open.py", "plugin.yaml", "package.json", "package-lock.json", "requirements-test.txt", "tsconfig.json", "LICENSE", "README.md", "README.zh-CN.md", "CHANGELOG.md", "UPSTREAM.json", "THIRD_PARTY_NOTICES.md"]
DOCS = ["GUIDE.zh-CN.md", "GUIDE.en.md", "DEVELOPMENT.md", "VALIDATION.md", "CATALOG.md", "CATALOG_PR.md", "catalog-entry.yaml.in"]
REQUIRED = ["runtime/worker.cjs", "runtime/library.cjs", "runtime/editor.html", "runtime/tools.json", "runtime/build-info.json", "desktop/plugin.js", "THIRD_PARTY_NOTICES.md"]


def main():
    for item in REQUIRED:
        if not (ROOT / item).is_file():
            raise SystemExit(f"Build required file first: {item}")
    build = json.loads((ROOT / "runtime/build-info.json").read_text())
    if not build.get("fullBuild"):
        raise SystemExit("A full Desktop + engine build is required before packaging.")
    for name, expected in build["inputs"].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise SystemExit(f"Source changed after the last build: {name}. Run npm run build.")
    paths = {ROOT / name for name in ALLOWED_FILES}
    paths.update(ROOT / "docs" / name for name in DOCS)
    for directory in ALLOWED_DIRS:
        paths.update(p for p in (ROOT / directory).rglob("*") if p.is_file())
    paths = sorted(p for p in paths if "__pycache__" not in p.parts and p.suffix != ".pyc")
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"Refusing missing or linked package input: {rel}")
        if path.suffix.lower() in {".py", ".ts", ".tsx", ".js", ".cjs", ".md", ".json", ".yaml", ".yml", ".html", ".in"}:
            text = path.read_text(encoding="utf-8")
            if re.search(r"/Users/[a-zA-Z0-9_-]+/|[A-Z]:\\Users\\[^\\]+\\|sk-or-v1-[A-Za-z0-9]{20,}|gh[op]_\w{20,}", text):
                raise SystemExit(f"Possible private path or credential in {rel}")
    version = json.loads((ROOT / "package.json").read_text())["version"]
    out = ROOT / "artifacts" / f"hermes-jot-{version}-local.zip"
    out.parent.mkdir(exist_ok=True)
    manifest = []
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            rel = path.relative_to(ROOT).as_posix()
            data = path.read_bytes()
            info = zipfile.ZipInfo(f"jot/{rel}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
            manifest.append({"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    report = {"archive": out.name, "bytes": out.stat().st_size, "sha256": hashlib.sha256(out.read_bytes()).hexdigest(), "files": manifest}
    (ROOT / "artifacts/package-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "files"}, indent=2))
    print(f"Packaged {len(manifest)} allow-listed files; no runtime notes, credentials or raw logs.")


if __name__ == "__main__":
    main()
