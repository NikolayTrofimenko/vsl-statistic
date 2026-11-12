#!/usr/bin/env bash
# Ship the working tree to the shared server and rebuild the container.
#
# The server holds a plain copy of the sources, not a clone. The tree is packed,
# unpacked into a staging directory and mirrored onto the live one with
# `rsync --delete`, so files deleted locally disappear there too.
#
#   SSH_KEY=~/.ssh/madamcoco_deploy bash deploy/push-source.sh [user@host]
#
# Environment:
#   SSH_KEY   private key to authenticate with (default: ssh's own resolution)
#   NO_BUILD  set to 1 to sync only, leaving the container untouched
set -euo pipefail

TARGET="${1:-craft@38.180.160.192}"
REMOTE_DIR="vsl-statistic"
STAGING="vsl-statistic-staging"
COMPOSE="deploy/docker-compose.prod.yml"
DOMAIN="trueeuphoriaanalytics.online"

# known_hosts by explicit path: on Windows with a non-ASCII user name ssh
# resolves its default location wrongly and fails host verification.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o "UserKnownHostsFile=$HOME/.ssh/known_hosts")
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")

cd "$(dirname "$0")/.."

# Never shipped: build output and caches (rebuilt in the image), the local
# secrets file and data (the server has its own), the sample landing.
EXCLUDES=(
  --exclude=./.git
  --exclude=./node_modules
  --exclude=./dist
  --exclude=./dist-server
  --exclude=./.angular
  --exclude=./data
  --exclude=./example-land
  --exclude=./.env
  --exclude=./tmp
  # Screen recordings and other media dropped into the project root.
  --exclude='./*.mp4'
  --exclude='./*.mov'
)

echo "→ Пакую исходники"
tar czf - "${EXCLUDES[@]}" . |
  ssh "${SSH_OPTS[@]}" "$TARGET" "
    set -euo pipefail
    rm -rf ~/$STAGING && mkdir -p ~/$STAGING ~/$REMOTE_DIR
    tar xzf - -C ~/$STAGING
  "

echo "→ Обновляю $TARGET:~/$REMOTE_DIR"
ssh "${SSH_OPTS[@]}" "$TARGET" "
  set -euo pipefail
  rsync -a --delete --exclude=.env ~/$STAGING/ ~/$REMOTE_DIR/
  rm -rf ~/$STAGING
  test -f ~/$REMOTE_DIR/.env || { echo '✗ На сервере нет ~/$REMOTE_DIR/.env — см. deploy/README.md'; exit 1; }
"

if [ "${NO_BUILD:-0}" = "1" ]; then
  echo "✓ Исходники обновлены, сборка пропущена (NO_BUILD=1)"
  exit 0
fi

echo "→ Пересобираю контейнер (несколько минут)"
ssh "${SSH_OPTS[@]}" "$TARGET" "
  set -euo pipefail
  cd ~/$REMOTE_DIR
  docker compose -f $COMPOSE up -d --build
  docker image prune -f >/dev/null
"

# The domain is served by the shared edge Caddy; a missing site block there
# would leave us running but unreachable, so say so instead of failing quietly.
echo "→ Проверяю, что Caddy знает про $DOMAIN"
ssh "${SSH_OPTS[@]}" "$TARGET" "
  docker exec edge-caddy-1 grep -q '^$DOMAIN' /etc/caddy/Caddyfile \
    && echo '  блок сайта на месте' \
    || echo '  ✗ в Caddyfile проекта edge нет блока $DOMAIN — см. ~/edge/README.md'
"

echo "→ Проверяю"
for i in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" || true)
  [ "$code" = "200" ] && break
  sleep 3
done
echo "health: $code"
[ "$code" = "200" ] || { echo "✗ Приложение не отвечает 200"; exit 1; }
echo "✓ Готово: https://$DOMAIN"
