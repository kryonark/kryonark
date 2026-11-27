// pm2 process file · `pm2 startOrRestart deploy/ecosystem.config.cjs --update-env`
// The agent exits when the studio writes a new .env.network after a deploy; pm2 restarts it on the new contracts.
const path = require("node:path");
module.exports = {
  apps: [{
    name: "kryonark-agent",
    cwd: path.join(__dirname, ".."),
    script: "agent.mjs",
    node_args: "--max-old-space-size=160",
    env: { NODE_ENV: "production", PORT: 5831 },
    max_memory_restart: "220M",
    time: true,
    autorestart: true,
    restart_delay: 2000,
    max_restarts: 1000,
  }],
};
