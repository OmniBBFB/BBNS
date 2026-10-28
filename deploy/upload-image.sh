#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: upload-image.sh bbns:release-tag ssh-destination [ssh-options...]}
destination=${2:?Missing SSH destination}
shift 2
[[ "$image" =~ ^bbns:[a-zA-Z0-9_.-]+$ ]] || { echo 'Expected a bbns release tag' >&2; exit 1; }
cd "$(dirname "$0")/.."
npm test
docker build --tag "$image" .
docker save "$image" | gzip | ssh "$@" "$destination" 'gzip -d | docker load'
ssh "$@" "$destination" "bash /root/docker/main/bbns/activate-image.sh '$image'"
