import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


root = Path.cwd()
audit = Path(__file__).resolve().parent
evidence = root / ".iolaus/evidence/owner-rescue/cancel-acceptance"
source = Path("/Users/Bryan/.local/share/opencode/qa-sources/owner-rescue-opencode-2.0.27")
pins = root / ".iolaus/evidence/owner-rescue/upstream-inbox"
protected_paths = list(json.loads((pins.parent / "host-restoration/protected-before.json").read_text()))
protected_paths += [str(Path.home() / ".iolaus/dist" / name) for name in ["index.js", "prompts.js", "tui.js"]]
assert not evidence.exists()
assert not (audit / "before.json").exists()


def fingerprint(path):
    path = Path(path)
    return {"realpath": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} if path.exists() else None


def output(argv, cwd=root):
    return subprocess.check_output(argv, cwd=cwd, text=True).strip()


def fixture():
    pin = json.loads((pins / "source.json").read_text())
    tracked = subprocess.check_output(["git", "diff", "--binary"], cwd=source)
    added = subprocess.run(["git", "diff", "--no-index", "--", "/dev/null", "packages/core/test/plugin/session-inbox.test.ts"], cwd=source, capture_output=True)
    assert added.returncode == 1
    assert tracked + added.stdout == (pins / "upstream.patch").read_bytes()
    assert output(["git", "rev-parse", "HEAD"], source) == output(["git", "rev-parse", "v2.0.27"], source) == pin["sha"]
    assert fingerprint(pins / "upstream.patch")["sha256"] == pin["patchSha256"]
    assert fingerprint(source / "bun.lock")["sha256"] == pin["lockSha256"]
    subprocess.run(["git", "apply", "--reverse", "--check", str(pins / "upstream.patch")], cwd=source, check=True)
    return {"source": str(source), "realpath": str(source.resolve()), "sha": pin["sha"], "patchSha256": pin["patchSha256"], "lockSha256": pin["lockSha256"], "launcher": fingerprint(pins / "patched-opencode.sh"), "status": output(["git", "status", "--short"], source)}


def snapshot():
    files = output(["git", "ls-files", "-co", "--exclude-standard"]).splitlines()
    active = [name for name in files if name.startswith(("src/", "tests/", "script/", "packages/")) or name in ["package.json", "bun.lock", "AGENTS.md", "README.md", "reference/active-manifest.json", "tsconfig.json"]]
    temporary = Path(tempfile.gettempdir())
    patterns = ["rescue-verification-*", "iolaus-rescue-feature-*", "iolaus-owner-rescue-qa-*", "iolaus-steering-qa-*", "iolaus-owner-rescue-cleanup-*"]
    sandboxes = sorted(str(path.resolve()) for base in [temporary, temporary / "opencode"] for pattern in patterns for path in base.glob(pattern))
    processes = [line.strip() for line in output(["ps", "-axo", "pid=,ppid=,pgid=,args="]).splitlines() if re.search(r"rescue-verification-|iolaus-rescue-feature-|iolaus-owner-rescue-qa-|iolaus-steering-qa-|owner-rescue-opencode-2\.0\.27/packages/cli/src/index\.ts", line)]
    return {"at": time.time(), "protected": {path: fingerprint(path) for path in protected_paths}, "sources": {name: fingerprint(root / name) for name in sorted(set(active))}, "build": {str(path.relative_to(root)): fingerprint(path) for path in sorted((root / "dist").glob("*.js"))}, "fixture": fixture(), "sandboxes": sandboxes, "processes": processes}


def save(name, value):
    (audit / name).write_text(json.dumps(value, indent=2) + "\n")


before = snapshot()
save("before.json", before)
assert not before["sandboxes"] and not before["processes"], "pre-existing QA activity prevents isolated acceptance"
env = {**os.environ, "QA_OPENCODE_SOURCE": str(source)}
env.pop("QA_STOCK_ARCHIVE", None)
env.pop("QA_FAULT", None)
env.pop("QA_OPENCODE_BIN", None)
env.pop("QA_HOST_MODE", None)
argv = ["node", "script/qa-owner-rescue-verify.mjs", str(evidence)]
save("command.json", {"argv": argv, "cwd": str(root), "QA_OPENCODE_SOURCE": str(source), "freshStockDownload": True, "gitSHA": output(["git", "rev-parse", "HEAD"]), "bun": output(["bun", "--version"]), "node": output(["node", "--version"])})
with (audit / "verifier.log").open("x") as log:
    result = subprocess.run(argv, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
after = snapshot()
save("after.json", after)
receipt = json.loads((evidence / "receipt.json").read_text())
changes = {key: before[key] != after[key] for key in ["protected", "sources", "fixture", "sandboxes", "processes", "build"]}
summary = {"verifierExit": result.returncode, "verdict": receipt["verdict"], "commands": len(receipt["commands"]), "mismatchedCommands": [entry for entry in receipt["commands"] if entry["exit"] != entry["expected"]], "unexpectedChanges": changes, "temporaryRemoved": receipt["temporaryRemoved"], "evidence": str(evidence)}
save("summary.json", summary)
print(json.dumps(summary, indent=2))
assert not any(changes.values()), changes
assert receipt["temporaryRemoved"]
assert len(receipt["commands"]) == 19 and not summary["mismatchedCommands"]
feature_source = json.loads((evidence / "feature/source.json").read_text())
fault_injection = json.loads((evidence / "feature/fault-injection.json").read_text())
assert feature_source["buildHash"] == fault_injection["originalHash"] == after["build"]["dist/index.js"]["sha256"]
assert feature_source["sha"] == after["fixture"]["sha"]
assert feature_source["patchSha256"] == after["fixture"]["patchSha256"]
assert feature_source["lockSha256"] == after["fixture"]["lockSha256"]
assert feature_source["launcherHash"] == after["fixture"]["launcher"]["sha256"]
save("artifact-binding.json", {"verdict": "PASS", "gitSHA": output(["git", "rev-parse", "HEAD"]), "sourceCount": len(after["sources"]), "build": after["build"], "featureSource": feature_source, "unmodifiedSandboxBuildHash": fault_injection["originalHash"], "beforeAfterUnchanged": not any(changes.values())})
sys.exit(result.returncode)
