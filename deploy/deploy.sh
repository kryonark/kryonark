#!/usr/bin/env bash
# Deploy Kryonark to the VPS: static site from web/, the studio as a pm2 app on :5830.
# studio/.env and studio/data/ (studio key, encrypted buyback wallet, burn history) live only on the VPS.
set -euo pipefail
HOST=${HOST:-root@203.194.113.116}
cd "$(dirname "$0")/.."
ssh -o BatchMode=yes "$HOST" "mkdir -p /var/www/kryonark/web /var/www/kryonark/studio/data /var/www/kryonark-acme && chmod 700 /var/www/kryonark/studio/data"
rsync -az --delete --exclude .DS_Store web/ "$HOST:/var/www/kryonark/web/"
rsync -az --delete --filter="protect /node_modules/" --filter="protect /data/" --filter="protect /.env" \
  --exclude node_modules --exclude /.env --exclude '/data/*' --exclude .DS_Store studio/ "$HOST:/var/www/kryonark/studio/"
ssh -o BatchMode=yes "$HOST" "export LC_ALL=C.UTF-8; set -e
  cd /var/www/kryonark/studio && npm install --omit=dev --no-audit --no-fund >/dev/null
  pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null
  for i in \$(seq 1 20); do sleep 1; curl -fsS -o /dev/null http://127.0.0.1:5830/studio && echo 'studio up on :5830' && break; done"
echo "deployed → https://kryonark.xyz"
