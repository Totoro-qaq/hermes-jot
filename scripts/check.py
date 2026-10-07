"""Run local checks without swallowing a failed command; never calls a model."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", action="store_true")
    args = parser.parse_args()
    node, hermes = shutil.which("node"), shutil.which("hermes")
    if not node or not hermes:
        raise SystemExit("Node.js and the Hermes CLI are required for local verification.")
    artifacts = ROOT / "artifacts"
    artifacts.mkdir(exist_ok=True)
    steps = [
        ("typecheck", [node, "node_modules/typescript/bin/tsc", "--noEmit"]),
        ("core-tests", [node, "--import", "tsx", "--test", *[str(p.relative_to(ROOT)) for p in sorted((ROOT / "tests").glob("*.test.ts"))]]),
        ("build", [node, "scripts/build.mjs"]),
        ("desktop-module", [node, "--experimental-vm-modules", "scripts/check-desktop-module.mjs"]),
        ("integration-tests", [hermes, "--run-module", "unittest", "discover", "-s", "tests_py", "-v"]),
        ("plugin-validation", [hermes, "plugins", "validate", str(ROOT), "--install-deps", "--json"]),
    ]
    for name, command in steps:
        log = artifacts / (name + (".json" if name == "plugin-validation" else ".log"))
        result = subprocess.run(command, cwd=ROOT, text=True, encoding="utf-8", capture_output=True)
        log.write_text(result.stdout + ("\n" + result.stderr if result.stderr else ""), encoding="utf-8")
        if result.returncode:
            print(f"FAIL {name}: see {log.name}")
            print((result.stdout + result.stderr)[-3500:])
            raise SystemExit(result.returncode)
        if name == "plugin-validation" and not json.loads(result.stdout)["ok"]:
            raise SystemExit("Plugin admission checks failed.")
        print(f"PASS {name}", flush=True)
    if args.package:
        subprocess.run([sys.executable, "scripts/package.py"], cwd=ROOT, check=True)
        subprocess.run([sys.executable, "scripts/check_package.py", "--hermes"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
