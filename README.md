# ☀️ sun2Agent

[![npm](https://img.shields.io/npm/v/sun2agent)](https://www.npmjs.com/package/sun2agent)
[![node](https://img.shields.io/node/v/sun2agent)](https://nodejs.org)
![license](https://img.shields.io/npm/l/sun2agent)

**A terminal AI chat agent with a native MCP client.** Connect any [Model Context Protocol](https://modelcontextprotocol.io) server — local or remote — and let the agent call its tools for you. Powered by the [NVIDIA NIM](https://build.nvidia.com) API.

```
╭ ☀️  sun2Agent  v1.0.1 ─────────────────────╮
│               Welcome back!                │
│                     o                      │
│                 ╭───────╮                  │
│                ─┤ ⬡   ⬡ ├─                 │
│                 │  >_   │                  │
│                 ╰───────╯                  │
│                    ─┴─                     │
│             Model gpt-oss-120b             │
╰────────────────────────────────────────────╯
```

## Why sun2Agent

Most MCP clients are wrapped inside a big editor or desktop app. sun2Agent is just a terminal — start it, point it at your MCP servers, and ask for things in plain language. The agent figures out which tools to call.

- 🔌 **Real MCP client** — `stdio` (local process), `http` (Streamable HTTP), and `sse` transports
- 🧰 **One server or all at once** — connect everything and let the model pick the right tool
- ⚙️ **Automatic tool-calling** — no tool syntax to memorize, just describe the task
- 🎛️ **Any NIM model** — swap models anytime with `/config`
- ⌨️ **Calm TUI** — rounded input box, live connection tags, `Esc` to interrupt anything

## Install

sun2Agent is a command-line tool, so install it **globally** (note the `-g`):

```bash
npm install -g sun2agent
```

Then run it:

```bash
sun2agent
```

Or try it without installing anything:

```bash
npx sun2agent
```

Requires **Node.js >= 18**.

> [!WARNING]
> Don't run `npm install sun2agent` (without `-g`) inside another project. That adds it as a local dependency and re-resolves *that project's* packages, which can fail with peer-dependency errors unrelated to sun2Agent. Use `-g` or `npx`.

## First run

1. Start it: `sun2agent`
2. Run `/config` and paste your **NVIDIA NIM API key**, then pick a model.
   > Get one free at [build.nvidia.com](https://build.nvidia.com) → choose a model → *Get API Key*. It starts with `nvapi-`.
3. Start chatting. Add MCP servers whenever you're ready — see below.

## Connecting MCP servers

**1. Open the config.** Run `/mcp` → **Add / Edit MCP**. This opens `~/.sun2agent/mcp.json` in your editor.

**2. Add servers** under `mcpServers`:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "my-http-server": {
      "type": "http",
      "url": "https://your-server.example.com/mcp",
      "headers": { "AUTHORIZATION": "Bearer YOUR_KEY" }
    },
    "my-sse-server": {
      "type": "sse",
      "url": "https://your-server.example.com/sse"
    }
  }
}
```

| `type` | Transport | Needs |
|--------|-----------|-------|
| `stdio` | Local child process | `command`, optional `args` / `env` |
| `http` | Streamable HTTP (alias: `remote`) | `url`, optional `headers` |
| `sse` | Server-Sent Events | `url`, optional `headers` |

Set `"enabled": false` on any server to skip it without deleting it.

**3. Connect.** Run `/mcp` → **Connect MCP**, then pick a server — or **Connect all MCPs** to load every server at once.

The active server appears as a green `@tag` under the input box (`@allMcps` when several are connected), and its tools are available to the agent immediately. Just ask:

```
› take a screenshot of example.com and tell me what's on it
  ⚙ playwright__browser_navigate({"url":"https://example.com"})
  ⚙ playwright__browser_take_screenshot()
sun2Agent: The page is a minimal placeholder titled "Example Domain"…
```

## Commands

| Command | Action |
|---------|--------|
| `/help`, `/?` | Show all commands and shortcuts |
| `/config` | Set your NVIDIA NIM API key and choose a model |
| `/mcp` | Manage MCP servers — add/edit, connect one or all, disconnect |
| `/delete` | Delete saved config and data |
| `/exit` | Quit |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` *(while typing)* | Clear the input |
| `Esc` *(empty box)* | Disconnect MCP, return to simple chat |
| `Esc` *(agent working)* | Stop the current reply or tool call |
| `Esc` *(in menus)* | Go back / cancel |
| `Ctrl+C` | Quit immediately |

## Troubleshooting

**Tools are listed but the model never calls them**
Some models tool-call more reliably than others. Try a different model with `/config`, or name the tool explicitly in your prompt.

## Guardrails

Because MCP tools run automatically on the model's say-so, every call passes through a layer of guards first. They live in `guardrails/` and use plain pattern matching — no extra model calls, no network activity, no measurable latency.

```
User prompt ──▶ inputGuard ──▶ LLM ──▶ tool call
                                          │
                    commandGuard ──▶ networkGuard ──▶ filesystemGuard
                                          │
                                    Execute tool
                                          │
                                     outputGuard ──▶ Terminal
```

| Guard | Blocks |
|-------|--------|
| **inputGuard** | Prompt injection, jailbreaks, system-prompt extraction |
| **commandGuard** | `rm -rf`, `sudo`, `mkfs`, `dd if=`, fork bombs, `curl … \| sh`, `git push --force` |
| **networkGuard** | Data exfiltration (`cat .env \| curl`), uploads (`curl -d`, `scp`, `nc`) |
| **filesystemGuard** | `.env`, `.ssh`, `.aws`, `id_rsa`, `*.pem`, path traversal, anything outside the project root |
| **outputGuard** | Masks API keys, AWS/GitHub/Slack tokens, JWTs, private keys in tool output |

A blocked call fails with a clear reason and is reported back to the model, which can then try a safe alternative.

All policy lives in [`guardrails/guardConfig.js`](guardrails/guardConfig.js) — edit that one file to tighten or relax the rules. Notable knobs:

- `projectRoot` — the filesystem sandbox. Defaults to the directory you launched from, so **start sun2Agent inside the project you want the agent working on.** File arguments pointing outside it are refused.
- `strictDomains` — off by default. Turn it on to restrict outbound URLs to `allowedDomains`.

Run the guard test suite (24 tests, no dependencies):

```bash
npm test
```

## Security & trust

- **Your keys stay local.** The API key and `mcp.json` live in `~/.sun2agent/` with owner-only permissions, and are never bundled with the package.
- **`mcp.json` can launch programs.** A `stdio` server runs whatever `command` you give it — treat the file like a shell script and only add servers you trust. The guards vet the launch command, but they can't tell a trustworthy server from a malicious one.
- **Guards reduce risk; they don't eliminate it.** They match known-dangerous patterns, so a novel phrasing can get through. Stay careful when a session mixes servers that read untrusted web content with servers that can take destructive actions — that combination is how prompt injection turns into real damage.

## Uninstall

```bash
sun2agent delete            # optional: remove saved config + mcp.json
npm uninstall -g sun2agent
```

## License

MIT
