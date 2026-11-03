"""Smoke-test the real image using synthetic config, no worker and no network."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


image = sys.argv[1]
pristine = "const fs=require('node:fs');for(const p of ['/app/.env','/app/config','/app/data','/app/.git'])if(fs.existsSync(p))process.exit(1);if(!fs.existsSync('/app/tools/container-worker.mjs'))process.exit(1);console.log('image contains no private config or data')"
print(docker('run', '--rm', '--network', 'none', image, 'node', '-e', pristine))
with tempfile.TemporaryDirectory(prefix='bbns-image-') as name:
    root = Path(name)
    config, data = root / 'config', root / 'data'
    config.mkdir(mode=0o755)
    data.mkdir(mode=0o755)
    (config / 'app.local.json').write_text(json.dumps({'host': '0.0.0.0', 'port': 3080, 'scheduler_config': 'config/scheduler.local.json'}))
    (config / 'scheduler.local.json').write_text(json.dumps({'summary_directory': 'data/summaries', 'timezone': 'Asia/Shanghai'}))
    for path in config.iterdir():
        path.chmod(0o644)
    container = docker('run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp', '--mount', 'type=bind,src=' + str(config) + ',dst=/app/config,readonly', '--mount', 'type=bind,src=' + str(data) + ',dst=/app/data,readonly', image)
    try:
        assert docker('exec', container, 'id', '-u') == '1000'
        state = json.loads(docker('inspect', container))[0]
        assert not any(line.startswith(('DEEPSEEK_', 'WECOM_')) for line in state['Config']['Env'])
        probe = "fetch('http://127.0.0.1:3080/health').then(async r=>{const d=await r.json();if(!r.ok||d.status!=='ok'||!d.read_only)process.exit(1)}).catch(()=>process.exit(1))"
        for attempt in range(40):
            result = subprocess.run(['docker', 'exec', container, 'node', '-e', probe], capture_output=True)
            if result.returncode == 0:
                break
            time.sleep(.25)
        else:
            raise RuntimeError('Reader did not become healthy')
        check = """
const root='http://127.0.0.1:3080';
for(const p of ['/','/api/summaries','/source-status.mjs'])if(!(await fetch(root+p)).ok)throw Error('Missing public route');
for(const p of ['/.env','/config/message.json','/data/scheduler/state.sqlite'])if((await fetch(root+p)).status!==404)throw Error('Private path exposed');
if((await fetch(root+'/api/summaries',{method:'POST',body:'{}'})).status!==405)throw Error('Reader accepts writes');
console.log('PASS non-root, read-only reader, public routes, private-path isolation and 405 for writes');
"""
        print(docker('exec', container, 'node', '--input-type=module', '-e', check))
    finally:
        subprocess.run(['docker', 'rm', '--force', container], check=True, stdout=subprocess.DEVNULL)
