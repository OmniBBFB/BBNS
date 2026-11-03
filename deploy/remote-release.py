"""Restricted production deploy command for the BBNS GitHub repository.

Receives a pinned image and short-lived registry token on stdin. Never print
payload, Compose environment, production config or task/delivery contents.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

IMAGE = 'ghcr.io/omnibbfb/bbns'


def valid_image(image):
    return isinstance(image, str) and re.fullmatch(re.escape(IMAGE) + r'@sha256:[a-f0-9]{64}', image) is not None


def update_image_env(original, image):
    lines = original.splitlines()
    matches = [i for i, line in enumerate(lines) if re.match(r'^\s*(?:export\s+)?BBNS_IMAGE\s*=', line)]
    if len(matches) != 1:
        raise ValueError('Expected exactly one BBNS_IMAGE setting')
    lines[matches[0]] = 'BBNS_IMAGE=' + image
    return '\n'.join(lines) + '\n'


def atomic_write(path, text):
    previous_mode = path.stat().st_mode & 0o777
    descriptor, name = tempfile.mkstemp(prefix='.bbns-release-', dir=path.parent)
    try:
        os.fchmod(descriptor, previous_mode)
        with os.fdopen(descriptor, 'w') as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(command, *, cwd=None, input=None, timeout=180):
    result = subprocess.run(command, cwd=cwd, input=input, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(command[:3]))
    return result.stdout.strip()


def has_active_tick(process_listing):
    return any(re.search(r'(?:^|/)(?:scheduler|workflow)-cli\.mjs\s+tick(?:\s|$)', line) for line in process_listing.splitlines())


def wait_for_idle(container, *, timeout=600):
    until = time.monotonic() + timeout
    while has_active_tick(run(['docker', 'top', container, '-eo', 'args'])):
        if time.monotonic() >= until:
            raise RuntimeError('Worker is busy; existing deployment was left running')
        time.sleep(2)


def health(container):
    probe = "fetch('http://127.0.0.1:3080/health').then(async r=>{const d=await r.json();if(!r.ok||d.application!=='bbns'||d.status!=='ok'||!d.read_only)process.exit(1)}).catch(()=>process.exit(1))"
    for attempt in range(30):
        result = subprocess.run(['docker', 'exec', container, 'node', '-e', probe], capture_output=True, timeout=8)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError('BBNS reader health check failed')


def deploy(payload):
    image = payload['image']
    if not valid_image(image):
        raise ValueError('Only the BBNS repository and a pinned digest are permitted')
    root = Path('/root/docker/main')
    directory = root / 'bbns/deploy'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Respect the existing board-games deployment lock too: both projects share
    # this Compose stack. No board-games configuration or container is changed.
    with (root / 'acquire/deploy/release.lock').open('a') as shared, (directory / 'release.lock').open('a') as own:
        fcntl.flock(shared, fcntl.LOCK_EX)
        fcntl.flock(own, fcntl.LOCK_EX)
        token, actor = payload.pop('registryToken'), payload.pop('actor')
        if not re.fullmatch(r'[A-Za-z0-9-]+(?:\[bot\])?', actor):
            raise ValueError('Invalid registry identity')
        with tempfile.TemporaryDirectory(prefix='bbns-registry-') as config:
            run(['docker', '--config', config, 'login', 'ghcr.io', '--username', actor, '--password-stdin'], input=token)
            run(['docker', '--config', config, 'pull', image], timeout=600)
        del token
        base = ['docker', 'compose', '-f', str(root / 'docker-compose.yml')]
        resolved = json.loads(run(base + ['config', '--format', 'json'], cwd=root))
        previous = {name: resolved['services'][name]['image'] for name in ['bbns-web', 'bbns-worker']}
        if len(set(previous.values())) != 1:
            raise ValueError('BBNS services must start on the same image')
        env_file = root / '.env'
        original = env_file.read_text()
        updated = update_image_env(original, image)
        worker = run(base + ['ps', '-q', 'bbns-worker'], cwd=root)
        if not worker:
            raise ValueError('Expected the existing BBNS worker')
        wait_for_idle(worker)
        backup = root / 'bbns/backups' / ('cicd-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        backup.mkdir(parents=True, mode=0o700)
        shutil.copy2(env_file, backup / 'main.env')
        shutil.copy2(root / 'docker-compose.yml', backup / 'docker-compose.yml')
        stopped = False
        changed = False
        activated = False
        try:
            # Cooperative shutdown; never run a second worker or a manual tick.
            stopped = True
            run(base + ['stop', '--timeout', '60', 'bbns-worker'], cwd=root, timeout=90)
            shutil.copytree(root / 'bbns/data', backup / 'data', symlinks=True)
            shutil.copytree(root / 'bbns/config', backup / 'config', symlinks=True)
            shutil.copy2(root / 'bbns/.env', backup / 'worker.env')
            (backup / 'worker.env').chmod(0o600)
            # Validate actual production configuration on a throw-away copy.
            # No network, no manual run, no live-ledger writes and no real send.
            audit = """
import {cpSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
cpSync('/snapshot-data','/app/data',{recursive:true});
const path='config/scheduler.local.json',config=JSON.parse(readFileSync(path,'utf8'));
const cli=config.workflow_version===2?'src/workflow-cli.mjs':'src/scheduler-cli.mjs';
const r=spawnSync(process.execPath,[cli,'check',path],{stdio:'pipe'});
if(r.status!==0)process.exit(1);
console.log('Offline production config and ledger check passed');
"""
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp', '--tmpfs', '/app/data:uid=1000,gid=1000', '--mount', 'type=bind,src=' + str(backup / 'data') + ',dst=/snapshot-data,readonly', '--mount', 'type=bind,src=' + str(backup / 'config') + ',dst=/app/config,readonly', '--env-file', str(backup / 'worker.env'), image, 'node', '--input-type=module', '-e', audit], timeout=180)
            atomic_write(env_file, updated)
            changed = True
            run(base + ['config', '--quiet'], cwd=root)
            selected = json.loads(run(base + ['config', '--format', 'json'], cwd=root))
            if any(selected['services'][name]['image'] != image for name in previous):
                raise RuntimeError('Compose is not using BBNS_IMAGE for both services')
            for name, service in resolved['services'].items():
                if name not in previous and selected['services'][name] != service:
                    raise RuntimeError('Unrelated Compose service would change')
            run(base + ['up', '-d', '--no-deps', 'bbns-web'], cwd=root)
            web = run(base + ['ps', '-q', 'bbns-web'], cwd=root)
            health(web)
            activated = True
            run(base + ['up', '-d', '--no-deps', 'bbns-worker'], cwd=root)
            worker = run(base + ['ps', '-q', 'bbns-worker'], cwd=root)
            time.sleep(3)
            state = json.loads(run(['docker', 'inspect', worker]))[0]['State']
            if not state['Running'] or state.get('Restarting') or state.get('OOMKilled'):
                raise RuntimeError('BBNS worker did not stay running')
            result = {'ok': True, 'image': image, 'previousImage': next(iter(previous.values())), 'backup': str(backup), 'web': web, 'worker': worker}
            (directory / 'release.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result))
        except Exception:
            if activated:
                run(base + ['stop', '--timeout', '60', 'bbns-worker'], cwd=root, timeout=90)
            if changed:
                # Restore the image setting only, keeping all other current keys.
                atomic_write(env_file, update_image_env(env_file.read_text(), next(iter(previous.values()))))
            if stopped:
                run(base + ['up', '-d', '--no-deps', 'bbns-web', 'bbns-worker'], cwd=root)
            # Preserve current task state, receipts and every new archive. Never
            # copy backup data over live data or replay delivery as rollback.
            raise


if __name__ == '__main__':
    if os.environ.get('SSH_ORIGINAL_COMMAND') != 'deploy':
        raise SystemExit('Only the deploy command is permitted')
    deploy(json.loads(sys.stdin.read(32768)))
