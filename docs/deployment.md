# VPS or cloud deployment

This guide deploys Sun2Agent as an always-on Telegram service. Your local CLI remains separate; it does not automatically connect to the cloud instance. Use Node.js 20 or 22+ and deploy one service instance per Telegram bot token.

## Before you start

- A VPS or an always-on cloud worker (not a sleeping web service).
- A Telegram bot token from `@BotFather` and your numeric Telegram user/chat ID.
- A model provider API key. The built-in NVIDIA provider works with the environment template; a custom OpenAI-compatible provider also needs its non-secret provider definition in the persistent `config.json`.
- Optional remote MCP credentials and `AGENT.md` instructions. Do not copy local filesystem, browser, or computer MCPs to a public server.

Copy `deploy/.env.example` to the host's secret environment settings. Replace the provider/model placeholders with a real model ID, set the required credentials, and set `SUN2AGENT_DATA_DIR` to persistent storage. Never commit a populated `.env` or paste secrets into `AGENT.md`.

Sun2Agent stores `config.json`, `mcp.json`, memory, skills, and schedules under `SUN2AGENT_DATA_DIR`. `AGENT.md` is normally read from the process working directory, so for persistent deployment also set `SUN2AGENT_AGENT_MD` to its persistent path, for example `/var/lib/sun2agent/AGENT.md`.

## VPS with systemd

1. Install Node.js 20 or 22+, create a dedicated `sun2agent` Linux user, put the release under `/opt/sun2agent`, and run `npm ci --omit=dev` there.
2. Create `/var/lib/sun2agent` owned by that user. Set both `SUN2AGENT_DATA_DIR=/var/lib/sun2agent` and `SUN2AGENT_AGENT_MD=/var/lib/sun2agent/AGENT.md` in the service environment.
3. Copy `deploy/.env.example` to `/etc/sun2agent/sun2agent.env`, fill in the required values, and restrict it with `chmod 600`. Do not commit or share this file.
4. Copy `deploy/mcp.remote.example.json` to `/var/lib/sun2agent/mcp.json` if using remote MCP. Keep only HTTPS servers intended for Telegram. Each exact name in `telegramTools` grants that tool permission to run without per-call approval, including possible writes/sends; review it before enabling. For secret headers, use `${ENV_NAME}` references backed by the service environment. Local stdio, filesystem, browser, and computer MCPs are not started by this service.
5. Put your `AGENT.md` in the persistent directory. Set `SUN2AGENT_TIMEZONE` to your IANA timezone (for example `Asia/Kolkata`) before creating Telegram schedules.
6. Install `deploy/vps/sun2agent.service` as `/etc/systemd/system/sun2agent.service`, then run `systemctl daemon-reload`, `systemctl enable --now sun2agent`, and inspect `journalctl -u sun2agent`.
7. Send a Telegram message, restart the service, then verify it reconnects and retains memory/schedules.

Run exactly one polling service for a bot token. Do not run the same bot in the local CLI and cloud at the same time.

## Render

1. Create a continuously running **Background Worker** from the Sun2Agent repository. Use `npm ci` as the build command and `npm run start:service` as the start command.
2. Add the required values from `deploy/.env.example` in Render's environment/secret settings. Set `SUN2AGENT_DATA_DIR=/var/lib/sun2agent` and `SUN2AGENT_AGENT_MD=/var/lib/sun2agent/AGENT.md`. Set `SUN2AGENT_TIMEZONE` to your IANA timezone if using schedules.
3. Attach a persistent disk mounted at `/var/lib/sun2agent`. Keep exactly one worker instance for Telegram polling.

After the first deploy, open the worker's **Shell** tab. Copy `deploy/mcp.remote.example.json` to `$SUN2AGENT_DATA_DIR/mcp.json` if needed, then configure its HTTPS URL and trusted `telegramTools`. Upload `AGENT.md` to the configured persistent path. Optional `skills.md` belongs in the data directory. Keep credentials in Render environment variables and reference them in MCP headers with `${ENV_NAME}`. Restart after editing MCP/instruction files, then check the worker logs and send a Telegram test message. Only files on the persistent disk survive replacement of the worker; source files elsewhere do not.

## First-deploy checklist

- Confirm the service starts without an interactive prompt and logs that Telegram is running.
- Send a message from the allowlisted Telegram account.
- If enabled, test one explicitly trusted remote MCP tool and confirm untrusted tools are unavailable.
- Create a schedule only after setting `SUN2AGENT_TIMEZONE`; confirm it fires while the service stays running.
- Restart/redeploy and confirm memory, schedules, `mcp.json`, and `AGENT.md` remain available.
- Back up the persistent data directory and rotate provider, Telegram, and MCP credentials through the host's secret settings.

For a custom OpenAI-compatible provider, provision its non-secret provider definition (`id`, base URL, supported models) in `config.json`; the environment variables select its ID/model and inject its API key.

## Secrets and limitations

`SUN2AGENT_API_KEY`, `SUN2AGENT_TELEGRAM_BOT_TOKEN`, and remote MCP credentials are secrets. Set them in the host's secret settings; never place live values in Git, `AGENT.md`, or exported templates. `SUN2AGENT_TELEGRAM_CHAT_ID` restricts the bot to the configured private chat. The cloud service cannot control the user's laptop desktop, local browser profile, or local MCP processes.

This service does not expose an HTTP dashboard or health endpoint. Monitor it through systemd/host logs. For horizontal scaling or multiple users, move state to shared durable storage and use a coordinated Telegram webhook/queue design instead of multiple polling workers.
