#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: activate-image.sh bbns:release-tag [main-directory]}
main_directory=${2:-/root/docker/main}
[[ "$image" =~ ^bbns:[a-zA-Z0-9_.-]+$ ]] || { echo 'Expected a bbns release tag' >&2; exit 1; }
cd "$main_directory"
docker image inspect "$image" >/dev/null
docker compose config --quiet
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p bbns/backups
cp .env "bbns/backups/main.env.$stamp"
previous_image=$(python3 - "$image" <<'PY'
import pathlib,sys
p=pathlib.Path('.env'); lines=p.read_text().splitlines(); previous=''
for line in lines:
    if line.startswith('BBNS_IMAGE='): previous=line.split('=',1)[1]
lines=[line for line in lines if not line.startswith('BBNS_IMAGE=')]
p.write_text('\n'.join(lines+['BBNS_IMAGE='+sys.argv[1]])+'\n')
print(previous)
PY
)
restore_image() {
  if [[ -n "$previous_image" ]]; then
    cp "bbns/backups/main.env.$stamp" .env
    docker compose up -d --no-deps bbns-web bbns-worker
  fi
}
if ! docker compose up -d --no-deps bbns-web bbns-worker; then
  restore_image; exit 1
fi
for attempt in {1..20}; do
  if docker compose exec -T bbns-web node -e "fetch('http://127.0.0.1:3080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "BBNS deployed: $image"; exit 0
  fi
  sleep 2
done
restore_image
echo 'Reader health check failed; review worker task/delivery receipts before any workflow rollback.' >&2
exit 1
