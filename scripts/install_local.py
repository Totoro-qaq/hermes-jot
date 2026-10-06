"""Explicit local developer install from the reviewed archive; no network or self-update hook."""
from pathlib import Path, PurePosixPath
from datetime import datetime
import argparse
import hashlib
import json
import os
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True, help="The target Hermes data directory")
    parser.add_argument("--replace", action="store_true", help="Back up an existing local Jot install first")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "artifacts/package-manifest.json").read_text())
    archive = ROOT / "artifacts" / manifest["archive"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["sha256"]:
        raise SystemExit("The archive no longer matches its manifest. Rebuild it first.")
    plugins = args.home.resolve() / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)
    target = plugins / "jot"
    if (target.exists() or target.is_symlink()) and not args.replace:
        raise SystemExit("A Jot install exists. Review it, then use --replace if appropriate.")
    staging = Path(tempfile.mkdtemp(prefix=".jot-install-", dir=plugins))
    backup = None
    prior_link = None
    try:
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                name = PurePosixPath(item.filename)
                if not name.parts or name.parts[0] != "jot" or name.is_absolute() or ".." in name.parts:
                    raise SystemExit("Unexpected archive path.")
            source.extractall(staging)
        candidate = staging / "jot"
        for item in manifest["files"]:
            file = candidate / item["path"]
            if hashlib.sha256(file.read_bytes()).hexdigest() != item["sha256"]:
                raise SystemExit("Extracted content does not match the package manifest.")
        if target.is_symlink():
            if target.resolve() != ROOT:
                raise SystemExit("Refusing to replace an unrelated plugin link.")
            prior_link = target.resolve()
            target.unlink()  # The development source remains untouched.
        elif target.exists():
            if not (target / "plugin.yaml").is_file():
                raise SystemExit("Existing target is not a recognizable Jot plugin.")
            backups = args.home.resolve() / "plugin-install-backups"
            backups.mkdir(exist_ok=True)
            backup = backups / ("jot-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
            target.rename(backup)
            print("Previous local package backed up:", backup)
        try:
            candidate.rename(target)
        except OSError:
            if not target.exists() and not target.is_symlink():
                if backup is not None:
                    backup.rename(target)
                elif prior_link is not None:
                    target.symlink_to(prior_link, target_is_directory=True)
            raise
        print("Installed local package:", target)
        print("Note data was not moved. Rescan/enable Jot in Hermes Desktop; reload its backend if needed.")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()
