#!/bin/sh
# The image's entrypoint. It runs the server as `node`, however the container
# was started.
#
#   Started as node (the image's default user): runs the server, as always.
#   Started as root (`user: "0"`), with neither setting below: drops to node
#     with no capabilities, the same as starting as node.
#   Started as root, with OVERCLI_WORKER_UID: workers run as that user (see
#     src/main/org/workerUser.ts). The shared folders are opened to the
#     worker's group, and the server keeps only the capabilities it needs to
#     launch workers and look after what they write: setuid, setgid and
#     dac_override. Workers get none.
#   Started as root, with only OVERCLI_TEST_UID: repo tests run as that user;
#     the server keeps setuid and setgid.
set -eu

SERVER=/app/dist/cli/index.js

if [ "$(id -u)" != 0 ]; then
  exec node "$SERVER" "$@"
fi

DATA=${OVERCLI_HOME:-/data}
HOME_DIR=${HOME:-/data/home}
CAPS=

if [ -n "${OVERCLI_WORKER_UID:-}" ]; then
  WGID=${OVERCLI_WORKER_GID:-$OVERCLI_WORKER_UID}
  case "$OVERCLI_WORKER_UID$WGID" in
    *[!0-9]*) echo "OVERCLI_WORKER_UID and OVERCLI_WORKER_GID must be numbers" >&2; exit 64 ;;
  esac
  # The server reads what workers write through this group.
  if ! id -nG node | tr ' ' '\n' | grep -qx "$(getent group "$WGID" | cut -d: -f1)"; then
    getent group "$WGID" >/dev/null || groupadd -g "$WGID" overcli-work
    usermod -aG "$(getent group "$WGID" | cut -d: -f1)" node
  fi
  # Where workers write: HOME (their CLI config, sign-ins, transcripts,
  # worktrees, attachments), the repo clones, the default project, the
  # workspace and coordinator folders they run in, each worker's own folder,
  # team tasks' files, and run attachments. Keep in step with probeTargets
  # in src/main/org/workerUser.ts. Owned
  # by node, in the worker group, setgid, so what either side makes there
  # stays shared; the server runs with umask 002 to keep it writable.
  SHARED="$DATA/repos $DATA/projects $DATA/workspaces $DATA/coordinators $DATA/worker-files $DATA/team-files $DATA/flow-attachments"
  # shellcheck disable=SC2086
  mkdir -p "$HOME_DIR/.overcli/worktrees" "$HOME_DIR/.overcli/team-worktrees" "$HOME_DIR/.overcli/attachments" $SHARED
  # shellcheck disable=SC2086
  chown node "$DATA" "$HOME_DIR" "$HOME_DIR/.overcli" "$HOME_DIR/.overcli/worktrees" "$HOME_DIR/.overcli/team-worktrees" "$HOME_DIR/.overcli/attachments" $SHARED
  chmod 755 "$DATA"
  # Credentials the worker has no use for keep their own group and modes.
  walk() {
    d=$1; shift
    # -xdev: never into bind mounts (a read-only ~/.aws, say); they keep their own modes.
    find "$d" -xdev \( -path "$HOME_DIR/.ssh" -o -path "$HOME_DIR/.gnupg" -o -path "$HOME_DIR/.git-credentials" \
      -o -path "$HOME_DIR/.netrc" -o -path "$HOME_DIR/.config/gh" -o -path "$HOME_DIR/.overcli/session.log" \) -prune -o "$@"
  }
  for d in "$HOME_DIR" $SHARED; do
    walk "$d" ! -group "$WGID" -exec chgrp -h "$WGID" {} + 2>/dev/null || true
    walk "$d" ! -type l ! -perm -g+rw -exec chmod g+rwX {} + 2>/dev/null || true
    walk "$d" -type d ! -perm -g+s -exec chmod g+s {} + 2>/dev/null || true
  done
  # Each side runs git in folders the other made; git refuses those otherwise.
  git config --system --get-all safe.directory 2>/dev/null | grep -qx '\*' || git config --system --add safe.directory '*'
  CAPS=+setuid,+setgid,+dac_override
  umask 002
elif [ -n "${OVERCLI_TEST_UID:-}" ]; then
  CAPS=+setuid,+setgid
fi

if [ -z "$CAPS" ]; then
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- node "$SERVER" "$@"
fi
exec setpriv --reuid=node --regid=node --init-groups \
  --inh-caps=-all,$CAPS --ambient-caps=-all,$CAPS --bounding-set=-all,$CAPS \
  -- node "$SERVER" "$@"
