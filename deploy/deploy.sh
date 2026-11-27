#!/usr/bin/env bash
# Deploy Kryonark to the VPS: static site from web/, the studio (pm2, :5830) and the agent (pm2, :5831).
# Only on the VPS: studio/.env and studio/data/ (studio key, buyback wallet, burn history), agent/.key (the agent's
# own hot key, created there), agent/.env.network and web/assets/network.json (both written by the studio after a deploy).
set -euo pipefail
HOST=${HOST:-root@203.194.113.116}
cd "$(dirname "$0")/.."
ssh -o BatchMode=yes "$HOST" "mkdir -p /var/www/kryonark/web /var/www/kryonark/studio/data /var/www/kryonark/agent /var/www/kryonark-acme && chmod 700 /var/www/kryonark/studio/data /var/www/kryonark/agent"
rsync -az --delete --filter="protect /assets/network.json" --exclude /assets/network.json --exclude .DS_Store web/ "$HOST:/var/www/kryonark/web/"
rsync -az --delete --filter="protect /node_modules/" --filter="protect /.key" --filter="protect /.env" --filter="protect /.env.network" --filter="protect /.checks.json" \
  --exclude node_modules --exclude /.key --exclude /.env --exclude /.env.network --exclude /.checks.json --exclude .DS_Store agent/ "$HOST:/var/www/kryonark/agent/"
rsync -az --delete --filter="protect /node_modules/" --filter="protect /data/" --filter="protect /.env" \
  --exclude node_modules --exclude /.env --exclude '/data/*' --exclude .DS_Store studio/ "$HOST:/var/www/kryonark/studio/"
ssh -o BatchMode=yes "$HOST" "export LC_ALL=C.UTF-8; set -e
  cd /var/www/kryonark/studio && npm install --omit=dev --no-audit --no-fund >/dev/null
  pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null
  cd /var/www/kryonark/agent && npm install --omit=dev --no-audit --no-fund >/dev/null
  pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null
  for i in \$(seq 1 20); do sleep 1; curl -fsS -o /dev/null http://127.0.0.1:5830/studio && echo 'studio up on :5830' && break; done
  for i in \$(seq 1 20); do sleep 1; curl -fsS http://127.0.0.1:5831/agent/api/status >/dev/null && echo 'agent up on :5831' && break; done"
echo "deployed → https://kryonark.xyz"
