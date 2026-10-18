import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

evidence = Path(__file__).resolve().parent
source = Path(os.environ.get("QA_OPENCODE_SOURCE", "/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode/owner-rescue-opencode-2.0.27")).resolve()
sha = "1f4d07a4a519185955ae8ab2ea3607805509e386"
commands = []


def git(*args):
    return subprocess.check_output(["git", *args], cwd=source)


def run(name, argv, cwd, env):
    with (evidence / (name + ".log")).open("wb") as log:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    commands.append({"name": name, "argv": argv, "cwd": str(cwd), "exitCode": result.returncode})
    (evidence / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
    print(name, result.returncode, flush=True)
    return result.returncode


assert git("rev-parse", "HEAD").decode().strip() == sha
assert git("rev-parse", "v2.0.27").decode().strip() == sha
assert git("branch", "--show-current").decode().strip() == "plugin-inbox-read"
diff = git("diff", "--binary")
test = "packages/core/test/plugin/session-inbox.test.ts"
added = subprocess.run(["git", "diff", "--no-index", "--", "/dev/null", test], cwd=source, capture_output=True)
assert added.returncode == 1
(evidence / "upstream.patch").write_bytes(diff + added.stdout)
(evidence / "source.json").write_text(json.dumps({
    "source": str(source), "tag": "v2.0.27", "sha": sha, "branch": "plugin-inbox-read",
    "patchSha256": hashlib.sha256(diff + added.stdout).hexdigest(),
    "lockSha256": hashlib.sha256((source / "bun.lock").read_bytes()).hexdigest(),
    "bun": subprocess.check_output(["bun", "--version"]).decode().strip(),
    "node": subprocess.check_output(["node", "--version"]).decode().strip(),
    "dependenciesReused": (source / "node_modules").is_dir(),
}, indent=2) + "\n")

with tempfile.TemporaryDirectory(prefix="inbox-checks-", dir="/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode") as temporary:
    root = Path(temporary)
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "TMPDIR": temporary,
           "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
           "XDG_CACHE_HOME": str(root / "cache"), "XDG_STATE_HOME": str(root / "state"),
           "IOLAUS_HOME": str(root / "iolaus"), "OPENCODE_DISABLE_AUTOUPDATE": "1",
           "OPENCODE_DISABLE_MODELS_FETCH": "1", "TURBO_TELEMETRY_DISABLED": "1"}
    Path(env["HOME"]).mkdir()
    baseline = root / "baseline"
    baseline.mkdir()
    archive = root / "baseline.tar"
    with archive.open("wb") as output:
        subprocess.run(["git", "archive", sha], cwd=source, stdout=output, check=True)
    subprocess.run(["tar", "-xf", str(archive), "-C", str(baseline)], check=True)

    def link_modules(original, destination):
        destination.mkdir(exist_ok=True)
        for entry in original.iterdir():
            target = destination / entry.name
            if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink():
                link_modules(entry, target)
                continue
            resolved = entry.resolve()
            relative = resolved.relative_to(source) if resolved.is_relative_to(source) else None
            local = baseline / relative if relative is not None else None
            target.symlink_to(local if local is not None and local.exists() and "node_modules" not in relative.parts else resolved)

    manifests = [Path(item) for item in git("ls-files", "*package.json").decode().splitlines()]
    for manifest in manifests:
        modules = manifest.parent / "node_modules"
        if (source / modules).is_dir():
            link_modules(source / modules, baseline / modules)
    shutil.copy2(source / test, baseline / test)
    assert (baseline / "packages/core/node_modules/@opencode/plugin").resolve() == baseline / "packages/plugin"
    assert run("red-baseline", ["bun", "test", "test/plugin/session-inbox.test.ts"], baseline / "packages/core", env) != 0
    red = (evidence / "red-baseline.log").read_text()
    assert "0 pass" in red and "2 fail" in red and "undefined is not an object" in red
    assert git("diff", "--binary") == diff

    for name, argv, directory in [
        ("core-focused", ["bun", "test", "test/plugin/session-inbox.test.ts", "test/plugin/session-remove.test.ts", "test/plugin/session-compact.test.ts"], "packages/core"),
        ("core-plugin-tests", ["bun", "test", "test/plugin"], "packages/core"),
        ("plugin-tests", ["bun", "test"], "packages/plugin"),
        ("plugin-typecheck", ["bun", "typecheck"], "packages/plugin"),
        ("core-typecheck", ["bun", "typecheck"], "packages/core"),
        ("plugin-build", ["bun", "run", "build"], "packages/plugin"),
        ("core-build", ["bun", "run", "build"], "packages/core"),
        ("root-check", ["bun", "run", "check"], "."),
    ]:
        run(name, argv, source / directory, env)
    if commands[-1]["exitCode"]:
        run("baseline-root-check", ["bun", "run", "check"], baseline, env)

(evidence / "checks-cleanup.json").write_text(json.dumps({"temporary": temporary, "removed": not Path(temporary).exists()}, indent=2) + "\n")
assert git("diff", "--binary") == diff
assert all(item["exitCode"] == 0 for item in commands if item["name"] != "red-baseline"), commands
