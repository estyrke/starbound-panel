#!/bin/bash
# Smoke test for the base image: boots a container with a NoCloud seed, then
# commits it and boots new containers from the committed image with fresh
# instance-ids, checking that user_data runs each time.
#   docker/base/smoke.sh [cycles]      (default 3)
# This is also the reference for the container run settings (see README).
set -euo pipefail

IMAGE=${IMAGE:-starbound-panel-base:latest}
CYCLES=${1:-3}
WORK=$(mktemp -d)
NAME=sbp-smoke
trap 'docker rm -f $NAME >/dev/null 2>&1 || true; docker rmi -f sbp-smoke:committed >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# Create (not start) a container, drop the NoCloud seed in, start it.
boot() { # image instance-id marker
  local image=$1 iid=$2 marker=$3
  docker rm -f $NAME >/dev/null 2>&1 || true
  printf 'instance-id: %s\n' "$iid" > "$WORK/meta-data"
  printf '#!/bin/bash\necho %s >> /var/log/smoke.log\n' "$marker" > "$WORK/user-data"
  docker create --name $NAME --platform linux/amd64 \
    --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    --stop-signal SIGRTMIN+3 --stop-timeout 300 \
    "$image" >/dev/null
  docker cp "$WORK/." $NAME:/var/lib/cloud/seed/nocloud/
  docker start $NAME >/dev/null
  docker exec $NAME cloud-init status --wait >/dev/null || true
}

check() { # expected log content
  local got
  got=$(docker exec $NAME cat /var/log/smoke.log | tr '\n' ' ')
  if [ "$got" != "$1 " ]; then
    echo "FAIL: expected smoke.log '$1', got '$got'" >&2
    docker exec $NAME cloud-init status --long >&2 || true
    exit 1
  fi
  echo "ok: smoke.log = $1"
}

boot "$IMAGE" iid-0 run-0
check run-0
docker exec $NAME systemctl is-system-running --wait || true

# A plain restart (Hetzner reboot) keeps the instance-id: user_data must not re-run.
docker restart $NAME >/dev/null
docker exec $NAME cloud-init status --wait >/dev/null || true
check run-0

# The stop signal baked into the image must survive docker commit.
docker stop $NAME >/dev/null
docker commit $NAME sbp-smoke:committed >/dev/null
sig=$(docker inspect -f '{{.Config.StopSignal}}' sbp-smoke:committed)
[ "$sig" = "SIGRTMIN+3" ] || { echo "FAIL: stop signal '$sig' lost on commit" >&2; exit 1; }
# Same instance-id on a committed image: no re-run.
boot sbp-smoke:committed iid-0 run-should-not-run
check run-0

expected=run-0
for i in $(seq 1 "$CYCLES"); do
  docker stop $NAME >/dev/null
  docker commit $NAME sbp-smoke:committed >/dev/null
  boot sbp-smoke:committed "iid-$i" "run-$i"
  expected="$expected run-$i"
  check "$expected"
done
echo "PASS: user_data ran on first boot and on $CYCLES committed re-runs"
