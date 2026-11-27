// pm2 process file · `pm2 startOrRestart deploy/ecosystem.config.cjs --update-env`
const path = require("node:path");
module.exports = {
  apps: [{
    name: "kryonark-studio",
    cwd: path.join(__dirname, ".."),
    script: "server/server.mjs",
    node_args: "--env-file-if-exists=.env --max-old-space-size=120",
    env: { NODE_ENV: "production", PORT: 5830, HOST: "127.0.0.1", WEB_ROOT: "/var/www/kryonark/web", AGENT_DIR: "/var/www/kryonark/agent" },
    max_memory_restart: "180M",
    time: true,
    autorestart: true,
    max_restarts: 20,
  }],
};
