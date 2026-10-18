import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile

evidence = Path(__file__).resolve().parent


def probe(mode):
    env = {**os.environ, "QA_EVIDENCE_DIR": str(evidence / ("live" if mode == "live" else "failure-" + mode))}
    env.pop("QA_PROBE_FAULT", None)
    if mode != "live":
        env["QA_PROBE_FAULT"] = mode
    argv = ["node", str(evidence / "probe.mjs")]
    result = subprocess.run(argv, env=env, capture_output=True, text=True)
    (evidence / (mode + ".log")).write_text(result.stdout + result.stderr)
    receipt = json.loads((Path(env["QA_EVIDENCE_DIR"]) / "assertions.json").read_text())
    assert result.returncode == (0 if mode == "live" else 1), result.stderr
    assert receipt["status"] == ("PASS" if mode == "live" else "FAIL"), receipt
    assert ("HOST_CONTRACT: PASS" in result.stdout) == (mode == "live"), result.stdout
    assert receipt["cleanup"]["errors"] == [], receipt
    for key in ["hostStateUnchanged", "serverStopped", "mockStopped", "sandboxRemoved"]:
        assert receipt["cleanup"][key], receipt
    if mode == "spawn":
        assert "ENOENT" in receipt["error"], receipt
    if mode == "partial-setup":
        assert "Injected partial-setup failure" in receipt["error"], receipt
    return {"argv": argv, "env": {key: env[key] for key in ["QA_EVIDENCE_DIR", "QA_PROBE_FAULT"] if key in env},
            "exitCode": result.returncode, "expected": True}


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    commands = list(executor.map(probe, ["live", "spawn", "partial-setup"]))

with tempfile.TemporaryDirectory(prefix="inbox-wrapper-", dir="/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode") as sandbox:
    root = Path(sandbox)
    home = root / "home"
    home.mkdir()
    (root / ".inbox-qa-sandbox").write_text("isolated wrapper negative test\n")
    env = {"PATH": os.environ["PATH"], "QA_SANDBOX": sandbox, "HOME": str(home), "OPENCODE_TEST_HOME": str(home),
           "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
           "XDG_CACHE_HOME": str(root / "cache"), "XDG_STATE_HOME": str(root / "state"), "IOLAUS_HOME": str(root / "iolaus")}
    for name, args, extra in [("refused-command", ["service", "restart"], {}),
                              ("refused-state-path", ["--version"], {"XDG_DATA_HOME": "/outside-sandbox"}),
                              ("refused-unmarked-home", ["--version"], {"OPENCODE_TEST_HOME": "/outside-sandbox"})]:
        argv = [str(evidence / "patched-opencode.sh"), *args]
        result = subprocess.run(argv, env={**env, **extra}, capture_output=True, text=True, cwd=home)
        assert result.returncode != 0, name
        (evidence / (name + ".log")).write_text(result.stdout + result.stderr)
        commands.append({"name": name, "argv": argv, "exitCode": result.returncode, "expected": True})
    assert not (root / "data").exists()
    assert not (root / "config").exists()

(evidence / "live-commands.json").write_text(json.dumps(commands, indent=2) + "\n")
print("HOST_CONTRACT: PASS")
