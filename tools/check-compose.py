"""Validate the template with an empty temporary env file, never production."""
import os
from pathlib import Path
import subprocess
import tempfile

template = Path(__file__).resolve().parents[1] / 'deploy/compose.yml'
with tempfile.TemporaryDirectory(prefix='bbns-compose-') as name:
    root = Path(name)
    (root / 'bbns').mkdir()
    (root / 'bbns/.env').touch()
    subprocess.run(['docker', 'compose', '--project-directory', str(root), '-f', str(template), 'config', '--quiet'], env={**os.environ, 'BBNS_IMAGE': 'bbns:ci'}, check=True)
print('PASS Compose template with an isolated empty env file')
