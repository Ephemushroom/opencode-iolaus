import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time


ROOT = Path('/Users/Bryan/.local/share/opencode/worktree/c1d0b7/flow-owner-rescue')
EVIDENCE = ROOT / '.iolaus/evidence/owner-rescue/publication-compat'
BINARY = Path('/opt/homebrew/bin/opencode')
HOME = Path('/Users/Bryan')
DEPLOYED = HOME / 'Programme/Project/AI/opencode-iolaus/dist'
TEMP = Path('/private/var/folders/cy/qc1d9pgd1hq599hhhw_z2l2w0000gn/T/opencode')
COPY = EVIDENCE / 'qa-flow-steering-2.0.28.mjs'
EXPECTED_BUILD = 'effd43ee75d4702ed93ede83b1c0ddcd184b6098c1452a641ef8416fba0c1010'
EXPECTED_BINARY = '7d9e936ab23af4928e0dfbf94c9fe313aac0728eef34a06709e1d86ca8987341'
RUN = EVIDENCE / ('run-' + time.strftime('%Y%m%dT%H%M%S'))
RUN.mkdir()


def digest(path):
    if not path.exists():
        return 'absent'
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def save(name, value):
    (RUN / name).write_text(json.dumps(value, indent=2) + '\n')


def snapshot():
    protected = [BINARY, BINARY.resolve()]
    protected += [HOME / name for name in [
        '.iolaus/iolaus.json', '.iolaus/README.md',
        '.config/opencode/opencode.json', '.config/opencode/opencode.jsonc',
        '.config/opencode/cli.json', '.config/opencode/cli.jsonc',
        '.config/opencode/service.json', '.config/opencode/service.jsonc',
    ]]
    protected += sorted(path for path in DEPLOYED.rglob('*') if path.is_file())
    tracked = subprocess.check_output([
        'git', 'ls-files', '-z', '--', 'src', 'tests', 'script', 'packages',
        'package.json', 'bun.lock', 'README.md', 'AGENTS.md',
    ], cwd=ROOT).decode().split('\0')
    source = [ROOT / path for path in tracked if path]
    source += [ROOT / path for path in [
        'src/dag/rescue.ts', 'tests/owner-rescue.test.ts',
        'tests/owner-rescue-runner.test.ts',
    ]]
    source += sorted(path for path in (ROOT / 'dist').rglob('*') if path.is_file())
    return {
        'protected': {str(path): digest(path) for path in protected},
        'sourceAndBuild': {str(path.relative_to(ROOT)): digest(path) for path in source},
        'binaryRealpath': str(BINARY.resolve()),
        'driverCopy': digest(COPY),
    }


def descendants(pid):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True)
    table = [tuple(map(int, line.split())) for line in rows.splitlines()]
    result = [pid]
    for parent in result:
        result += [child for child, parent_id in table if parent_id == parent]
    return result


before = snapshot()
save('before.json', before)
temporary = None
process = None
failure = None
cleanup_errors = []
exit_code = None
started = time.time()
try:
    assert digest(BINARY) == EXPECTED_BINARY
    assert digest(ROOT / 'dist/index.js') == EXPECTED_BUILD
    package = json.loads((ROOT / 'package.json').read_text())
    assert package['version'] == '0.1.0'
    assert package['peerDependencies']['@opencode/plugin'] == '2.0.27'
    for dependency in ['@opencode/plugin', '@opencode/client', '@opencode/schema']:
        assert package['devDependencies'][dependency] == '2.0.27'
    original = (ROOT / 'script/qa-flow-steering.mjs').read_text()
    replacements = [
        ('const root = resolve(new URL("..", import.meta.url).pathname)',
         'const root = ' + json.dumps(str(ROOT))),
        ('.iolaus/evidence/flow-steering-sdk/live-matrix',
         '.iolaus/evidence/owner-rescue/publication-compat/live-matrix-2.0.28'),
        ('assert.equal(version, `opencode v${sdk}`)',
         'assert.equal(version, "opencode v2.0.28")'),
        ('node script/qa-flow-steering.mjs ${evidence}',
         'node .iolaus/evidence/owner-rescue/publication-compat/qa-flow-steering-2.0.28.mjs ${evidence}'),
    ]
    expected_copy = original
    for old, new in replacements:
        assert expected_copy.count(old) == 1
        expected_copy = expected_copy.replace(old, new)
    assert COPY.read_text() == expected_copy, 'copy contains an unauthorized change'
    assert 'rescue:' not in expected_copy and 'ownerModel:' not in expected_copy
    assert 'spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"]' in expected_copy
    for parent in [TEMP, *TEMP.parents]:
        for name in ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']:
            assert not (parent / name).exists(), 'ancestor config would enter sandbox'
    temporary = Path(tempfile.mkdtemp(prefix='iolaus-publication-compat-', dir=TEMP)).resolve()
    command = [shutil.which('node'), str(COPY), str(RUN / 'matrix')]
    env = {'PATH': os.environ['PATH'], 'HOME': str(HOME), 'TMPDIR': str(temporary), 'QA_OPENCODE_BIN': str(BINARY)}
    save('invocation.json', {
        'command': command, 'cwd': str(ROOT), 'environment': env,
        'binary': {'path': str(BINARY), 'realpath': str(BINARY.resolve()), 'sha256': digest(BINARY)},
        'expectedHostVersion': 'opencode v2.0.28', 'sdkPin': '2.0.27',
        'rescueConfiguration': 'absent', 'buildSha256': EXPECTED_BUILD,
        'hostCommands': [['--version'], ['serve', '--hostname', '127.0.0.1', '--port', '0']],
        'managedServiceCommands': [], 'timeoutSeconds': 600,
    })
    with (RUN / 'stdout.log').open('w') as stdout, (RUN / 'stderr.log').open('w') as stderr:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        exit_code = process.wait(timeout=600)
    assert exit_code == 0, f'driver exit code: {exit_code}'
    receipt = json.loads((RUN / 'matrix/receipt.json').read_text())
    assert receipt['verdict'] == 'PASS'
    assert receipt['version'] == 'opencode v2.0.28' and receipt['sdk'] == '2.0.27'
    assert len(receipt['checks']) == 35 and all(check['verdict'] == 'PASS' for check in receipt['checks'])
    assert receipt['errors'] == [] and receipt['cleanupErrors'] == []
    assert all(receipt['cleanup'].values())
    sandbox = Path(receipt['isolation']['env']['TMPDIR'])
    assert sandbox.is_relative_to(temporary)
    for key in ['HOME', 'USERPROFILE', 'IOLAUS_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_TEST_HOME']:
        assert Path(receipt['isolation']['env'][key]).is_relative_to(sandbox)
    assert receipt['isolation']['databasePaths']
    assert all(Path(path).is_relative_to(sandbox) for path in receipt['isolation']['databasePaths'])
except BaseException as error:
    failure = f'{type(error).__name__}: {error}'
finally:
    if process is not None and process.poll() is None:
        for pid in reversed(descendants(process.pid)):
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=10)
    if temporary is not None:
        try:
            shutil.rmtree(temporary)
        except OSError as error:
            cleanup_errors.append(str(error))
    after = snapshot()
    save('after.json', after)
    if after != before:
        failure = (failure or '') + ' protected state, source, build, or driver changed'
    if cleanup_errors:
        failure = (failure or '') + ' outer cleanup failed'
    result = {
        'compatibility': 'BLOCKED' if failure else 'PASS', 'failure': failure,
        'exitCode': exit_code, 'durationSeconds': round(time.time() - started, 3),
        'hostVersion': 'opencode v2.0.28', 'binarySha256': EXPECTED_BINARY,
        'buildSha256': EXPECTED_BUILD, 'evidence': str(RUN),
        'protectedStateUnchanged': after == before,
        'outerSandboxRemoved': temporary is None or not temporary.exists(),
        'cleanupErrors': cleanup_errors,
    }
    save('summary.json', result)
    print(json.dumps(result, indent=2))

raise SystemExit(1 if failure else 0)
