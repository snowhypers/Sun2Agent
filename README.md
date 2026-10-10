<div align="center">

# ☀️ Sun2Agent

### Open-Source AI Agent CLI · Native MCP Client ·  Automation
**Your model. Your tools. AI automation in your terminal.**

Sun2Agent is a free, open-source **AI agent harness** with MCP server connections, browser automation, workspace tools, web search, and Telegram chat. OpenAI-compatible models. Apply reusable **Skills (`skills.md`)**, **agent instructions (`AGENT.md`)**, and **custom memory (`memory.md`)**—with **5-layer guardrails**, **HITL approvals**, an optional **Docker sandbox** and **LangSmith tracing** with **zero built-in telemetry**.

[![npm version](https://img.shields.io/npm/v/sun2agent?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/sun2agent)
[![npm total downloads](https://img.shields.io/npm/dt/sun2agent?color=cb3837&logo=npm&label=%20downloads)](https://www.npmjs.com/package/sun2agent)
[![Node.js version](https://img.shields.io/node/v/sun2agent?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/sun2agent?color=blue)](https://github.com/snowhypers/Sun2Agent/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/snowhypers/Sun2Agent?style=social)](https://github.com/snowhypers/Sun2Agent/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/snowhypers/Sun2Agent)](https://github.com/snowhypers/Sun2Agent/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/snowhypers/Sun2Agent)](https://github.com/snowhypers/Sun2Agent/issues)
[![Issues Welcome](https://img.shields.io/badge/issues-welcome-brightgreen.svg)](https://github.com/snowhypers/Sun2Agent/issues)
[![Maintained](https://img.shields.io/badge/maintained-yes-success.svg)](https://github.com/snowhypers/Sun2Agent/commits/main)

**[Try Now](#try-it-now) · [Install](#install) · [Features](#features) · [MCP](#mcp-client--model-context-protocol) · [Skills](#ai-agent-skills) · [Context](#context) · [Sandbox](#docker-sandbox) · [Security](#security--guardrails) · [FAQ](#faq)**

⭐ **[Star Sun2Agent on GitHub](https://github.com/snowhypers/Sun2Agent/stargazers)** — the fastest way to help other developers discover it.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/snowhypers/Sun2Agent/main/assets/sun2agent-demo.png" alt="Sun2Agent terminal AI agent CLI demo showing MCP tool calls and Human-in-the-Loop approval prompt" width="100%" />
</p>

---

<a id="what-is"></a>
## What Is Sun2Agent?

**Sun2Agent is an open-source AI agent CLI and native MCP client that runs directly in your terminal — no IDE, no desktop app, no subscription.**

It's for developers who want an AI agent that does more than chat: one that can call real tools through the **[Model Context Protocol](https://modelcontextprotocol.io)**, follow your project's own conventions via `AGENT.md`, reuse specialized instructions with Skills, remember your preferences locally, and ask before touching anything sensitive.

As an **agent harness**, Sun2Agent brings the model, project context, MCP tools, approvals, and execution loop together in one terminal CLI.

**Common searches this answers:**
`terminal AI agent` · `npm MCP client` · `AI agent CLI open source` · `secure autonomous coding agent` · `Model Context Protocol client npm` · `Claude Code alternative` · `Codex CLI alternative` · `self-hosted AI agent` · `human-in-the-loop AI agent`


<p align="center">
  <p>Sun2Agent architecture diagram showing context layer, tools layer, security layer, and the AI agent runtime loop
</p>

```text
                         ☀️ Sun2Agent
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
      Context                 Tools                Security
        │                      │                      │
     AGENT.md                 MCP                 Guardrails
      Skills               Web Search                HITL
      Memory                                        Sandbox
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                          AI Agent Runtime
                           LLM/ReAct Loop
                     (Reason → Act → Observe → Repeat)
                               │
             ┌──────────────────────────────────┐
             │          OBSERVABILITY           │
             │          LangSmith               │
             │       ├── LLM Tracing            │
             │       ├── MCP Tracing            │
             │       └── Error Visibility       │
             └──────────────────────────────────┘
```

---

<a id="try-it-now"></a>
##  Try It Now

```bash
npx sun2agent
```

Or install it globally so it's available in every terminal session:

```bash
npm install -g sun2agent
sun2agent
```

> Connect your tools. Select your Skills. Ask naturally.

---

<a id="why"></a>
## Why Choose Sun2Agent?

| | Typical MCP client | **Sun2Agent** |
|---|---|---|
| **Where it runs** | Bundled inside a heavy IDE or desktop app | Just a terminal — `npm i -g sun2agent` |
| **Tool approval** | All-or-nothing, or none at all | Risk-based Human-in-the-Loop for mutating and unknown tools |
| **Security model** | Trust the model | 5-layer guardrails block destructive commands, exfiltration, and credential access *before* execution |
| **Isolation** | Usually none | Optional one-command Docker sandbox with automatic session resume |
| **Memory & Skills** | Cloud-synced or none | Local-only `memory.md` / `skills.md`, zero telemetry |
| **Cost** | Often subscription-gated | Open source, [MIT-licensed](https://github.com/snowhypers/Sun2Agent/blob/main/LICENSE) — pay only for your own model usage |
| **Setup time** | Minutes to hours | Under 60 seconds with `npx sun2agent` |

---


<a id="features"></a>
## Features

| | Feature | Why it matters |
|---|---|---|
| 🤖 | **AI Agent CLI** | Full agent loop directly from your terminal — no browser tab, no desktop app |
| 🔌 | **Native MCP client** | `stdio`, `http` (Streamable HTTP), and `sse` transports, local or remote |
| ⚙️ | **Automatic tool-calling** | No tool syntax to memorize — describe the task in plain English |
| 📁 | **Automatic workspace tools** | Ask the agent to create, read, or edit files under the launch directory; it calls filesystem tools when needed |
| ✅ | **Maven test verification** | After writing Java tests, run `mvn test` in the workspace with fresh approval; report unverified work until it passes |
| 🌐 | **Opt-in browser automation** | Run `/browser` to connect an isolated Playwright browser only when needed |
| 🛡️ | **5-layer guardrails** | Input, command, network, filesystem, and output guards catch risk before it runs |
| ✋ | **Human-in-the-Loop** | Read-only tools run directly; one approval covers routine changes per MCP server and prompt, while high-risk calls ask each time |
| 🐳 | **Optional Docker sandbox** | The entire agent runs isolated, with automatic session resume when Docker restarts |
| 🧠 | **Local preference memory** | `~/.sun2agent/memory.md`, keyword search, zero external calls |
| 🎯 | **Reusable Skills** | Save instruction blocks once, toggle them on per chat |
| 📄 | **`AGENT.md` support** | Drop it in your project and the agent follows your conventions |
| 📊 | **Optional LangSmith tracing** | Traces sanitized by the output guard before they leave your machine |
| 🎛️ | **Multiple model providers** | Built-in NVIDIA NIM plus reusable OpenAI-compatible providers and models |
| 🔎 | **Optional web search (Tavily)** | Off by default; enable in `/config` for current events and live data |
| ✈️ | **Optional Telegram chat** | Chat with your running agent from one allowlisted private Telegram account |
| ⌨️ | **Responsive terminal UI** | Input box and footer adapt to terminal width; resizing preserves typed input |

### Latest codebase updates

- **Bring your own model provider:** save multiple OpenAI-compatible providers, add model IDs, and switch between them and built-in NVIDIA NIM through `/config`.
- **Responsive input:** the input box redraws when the terminal resizes, with connection tags and model information fitted to the available width.
- **Telegram search cancellation:** `/stop` cancels an active model response or pending Tavily search. The interrupted turn is removed from Telegram history so the next message can start cleanly.

These updates describe the current source code. The published npm package may lag behind it; use the [development instructions](#development) to run your local checkout.

---

<a id="install"></a>
## Install

> **Recommended: install globally** so `sun2agent` is available in every terminal session.

```bash
npm install -g sun2agent
```

Then launch it anywhere:

```bash
sun2agent
```

<details>
<summary>Prefer not to install globally?</summary>

```bash
npx sun2agent
```
</details>

**Requirements:** Node.js 20 or 22+, plus either an NVIDIA NIM API key or an OpenAI-compatible API endpoint.

> [!NOTE]
> Don't run `npm install sun2agent` (without `-g`) inside another project — it can trigger unrelated dependency-resolution errors in that project. Use `-g`, or `npx sun2agent`, instead.

---

<a id="quick-start"></a>
## Quick Start

```text
1. sun2agent       Start the agent
2. /config         Select NVIDIA or add an OpenAI-compatible provider and model
3. /mcp            Add and connect an MCP server
4. Ask naturally   "Read AGENT.md and run the tests"
```

Each normal launch starts a fresh conversation. Use `/new` to clear the current
chat without archiving it, or `/continue` to resume the current task after an
interruption. After a crash, `/continue` can restore the current session snapshot;
`/new` deletes that snapshot. Connected tools and the selected model stay as they are.
The footer shows estimated tokens retained in the active chat (`chat ~3.2k tokens`),
not provider-reported usage or remaining model capacity.
Use `/save` to preview and optionally keep a short task summary for the current
workspace. Approved summaries are stored separately from `memory.md` in
`~/.sun2agent/saved-sessions.json`; a relevant summary may be included as
context for a later task in the same workspace. `/new` does not delete approved
saved summaries.
While a model or tool turn is running, a non-editable input frame and the same
footer stay at the bottom of supported terminals; press Esc to stop the turn.

Get a free API key from **[NVIDIA Build](https://build.nvidia.com)**: pick a model, then select **Get API Key**. Keys begin with `nvapi-`.

For another OpenAI-compatible service, choose **Add custom OpenAI-compatible provider** in `/config`, then enter its provider name, base URL (for example `https://api.example.com/v1`), API key, and model ID. Providers and model IDs are saved for later selection in the owner-only `~/.sun2agent/config.json` file.

<a id="mcp-client--model-context-protocol"></a>
## MCP Client & Model Context Protocol

```text
                    Sun2Agent
                        │
                 MCP Client Layer
                        │
        ┌───────────────┼────────────────┐
        │               │                │
      stdio            HTTP              SSE
        │               │                │
        ▼               ▼                ▼
   Local Tools     Remote Tools     Remote Tools
```

Examples of what you can connect: filesystem tools, browser automation ([Playwright MCP](https://github.com/microsoft/playwright-mcp)), databases, internal APIs, or any custom MCP server.

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

**3. Connect.** Run `/mcp` → **Connect MCP**, then pick a server — or **Connect all MCPs** to load every server at once. The active server shows as a green `@tag` under the input box (`@allMcps` when several are connected).

---
### Tool approvals

When a connected MCP tool is needed, Sun2Agent shows the exact proposed call and asks:

```text
Allow this MCP tool call?
Allow — Don't allow
[Enter] Allow    [Esc] Don't allow
```

Read-only calls need no approval. One approval covers routine changes on the same MCP server for the current prompt, then expires. Deletes, sends, code execution, unknown actions, and other high-risk calls require a fresh decision. A denied call is skipped and reported back to the model.

### Telegram (optional)

Run `/config` and answer **Yes** to **Connect Telegram?**. Paste the bot token created with Telegram's `@BotFather`, then enter your numeric Telegram user/chat ID. Sun2Agent verifies both values and sends a connection message.

Answering **No** disables the Telegram connection without deleting the saved bot token or chat ID. A later `/config` can reuse those credentials. They remain in the owner-only `~/.sun2agent/config.json` file and are never printed in the terminal.

The CLI must remain running to receive Telegram messages. Beneath each user message, the bot immediately replies with `Agent is typing ...`, then progressively edits that same reply as text streams in. If Tavily web search is enabled in `/config`, Telegram can use `web_search` and shows `Agent is searching ...` while it runs. The configured private chat can also use connected remote read-only MCP tools; local MCP, browser, computer, and approval-required actions stay unavailable.

| Telegram command | Action |
|---|---|
| `/start` | Show pairing status and help |
| `/new` | Clear this Telegram chat's context |
| `/stop` | Abort the active model response or pending web search |

Stopping a turn removes its incomplete messages from Telegram history; earlier completed conversation remains available.

### Scheduled Telegram tasks

With Telegram configured, try `Every day at 9 PM, summarize today’s AI news and send it to Telegram` or `Today at 8 PM, check email`. A schedule needs a task, time, and **once** or **daily** recurrence; Sun2Agent asks when one is missing or the time conflicts with words like “morning.” The saved schedule shows the machine’s detected timezone. `/schedule` lists jobs in the CLI; select one for details or confirmed deletion. Jobs are stored in `~/.sun2agent/schedules.json` and run only while the CLI stays open. Scheduled work uses only read-only Telegram tools. Sun2Agent starts preparing the result about one minute early and retries a failed preparation up to twice. If it is still working at the scheduled time, it sends a Telegram status message, then the result when ready.

---

<a id="use-cases"></a>
## Use Cases

**Understand an unfamiliar codebase**
> "Read this repository, explain the architecture, and flag anything risky."
With a filesystem MCP server connected, Sun2Agent inspects your project and reports back.

**Run project-aware workflows**
> "Read AGENT.md, follow the project rules, and run the tests."
The agent combines your stated conventions with the tools available to it.

**Automate browser tasks**
> "Open this site, take a screenshot, and click the pricing link."
Run `/browser`, then describe the flow in plain English. It uses installed Google Chrome with an isolated temporary profile. Logins, submissions, purchases, uploads, downloads, permission dialogs, and account changes require explicit approval.

**Apply a consistent review process**
Activate a `Code Review` or `Security Audit` Skill so every review follows the same checklist, every time.

**Execute sensitive actions with a human in the loop**
Mutating and unknown MCP calls route through guardrails and an explicit approval prompt; read-only calls still pass guardrails but do not interrupt the user.

---

<a id="commands"></a>
## Commands

| Command | Action |
|---------|--------|
| `/help`, `/?` | Show all commands and shortcuts |
| `/config` | Select/add model providers and configure optional services and Telegram |
| `/browser` | Connect isolated Playwright browser automation tools |
| `/computer` | Connect native desktop control on demand; check permissions and choose image support |
| `/computer disconnect` | Disconnect desktop control without affecting other plugins |
| `/mcp` | Manage MCP servers — add/edit, connect one or all, disconnect |
| `/agent` | Open the project's `AGENT.md` (creates a template on first use) |
| `/memory` | Open and edit local `~/.sun2agent/memory.md` |
| `/skills` | Add/edit `skills.md` and choose which Skills are active |
| `/schedule` | List scheduled Telegram tasks, view details, or delete one |
| `/delete` | Delete saved config and data |
| `/exit` | Quit |

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` *(while typing)* | Clear the input |
| `Esc` *(empty box)* | Disconnect MCP/browser or clear selected Skills; workspace tools stay available |
| `Esc` *(agent working)* | Stop the current reply or tool call |
| `Esc` *(in menus)* | Go back / cancel |
| `Ctrl+C` | Quit immediately |

---
### Computer control (optional)

Run `/computer` to start the pinned `@zavora-ai/computer-use-mcp` package through `npx`.
The first connection may need a download; startup has a 30-second timeout.
This controls your **real desktop**, not an isolated browser. Node.js 20+ and an
interactive desktop are required. Docker mode does not expose the host desktop.

On macOS, grant the trusted host Accessibility and Screen Recording permissions;
app scripting may additionally request Automation permission. The plugin runs
`doctor` and displays its capability report. A connection alone does not guarantee
that every application is controllable.

Choose image support only if your selected model and endpoint support image input.
Otherwise the agent uses accessibility tools; screenshots are omitted, not sent as
base64 text. In vision mode the latest screenshot can be sent to your model provider;
image bytes are excluded from saved chat history and LangSmith traces.

Esc cancels connecting or an active task. Esc on an empty input disconnects
`/computer` first, leaving other plugins connected. At an approval prompt, Esc
declines that action. Completed actions cannot be undone by cancellation.
Read-only desktop checks, including menu-bar inspection, need no HITL approval.
Opening or activating the same app shares one approval for the current prompt;
another app or prompt asks again. Clicks, menu selections, typing, scripts and
other desktop changes still require fresh approval when HITL is enabled.

To keep model requests smaller, Sun2Agent initially exposes common computer
tools and lets the agent find other tools with `computer__sun2agent_search_tools` when
needed. `computer__sun2agent_wait_for_window` checks for an app window locally, avoiding
repeated model calls just to wait and inspect. These helpers do not bypass
guardrails or action approvals.

While `/computer` is connected, transient model HTTP failures retry once, respecting
`Retry-After` up to 30 seconds. Longer cooldowns and invalid requests are returned
without retrying. Completed desktop tools are not replayed by this retry.

### Custom model providers

1. Run `/config` and select **Add custom OpenAI-compatible provider**.
2. Enter a provider name and its OpenAI-compatible base URL, such as `https://api.example.com/v1`.
3. Enter the API key and the exact model ID supplied by that service.
4. Answer whether the provider supports **OpenAI tool calling**. Browser, workspace, and other MCP tools require a model with compatible tool-calling support.
5. Complete the remaining configuration prompts.

To switch later, run `/config`, choose a saved provider, and select its model. Choose **Add another model ID** to save another model for that provider. NVIDIA NIM remains available as a built-in choice.

Custom endpoints must support the OpenAI-compatible Chat Completions API; compatibility with other API formats is not implied. The setup currently requires a non-empty API key, including for local endpoints. Requests and chat context go to the selected provider, so only configure services you trust.


<a id="context"></a>
## Context: AGENT.md, Memory & Skills

Sun2Agent builds up what the agent knows about you and your project from three local, plain-text layers — no cloud sync, no telemetry. Together they're what "context" means for Sun2Agent: **project rules, remembered preferences, and reusable behaviors.**

```text
 AGENT.md   → per-project conventions, read from your repo
 memory.md  → per-user preferences, remembered across sessions
 skills.md  → per-user reusable instruction blocks, toggled on per chat
```

All three are injected into the system prompt as clearly-labelled, **advisory-only** context — in that order (`AGENT.md` → Skills → memory). None of them can override your core instructions or any guardrail.

<a id="agent-md"></a>
### Agent Instructions (`AGENT.md`)

Sun2Agent reads project-specific instructions from an `AGENT.md` file in the directory you launch from. Type `/agent` to open (or create) it — a template is generated on first use:

```markdown
# Project Instructions

- Use JavaScript.
- Use npm.
- Run npm test after changes.
- Follow the existing project structure.
```

> [!IMPORTANT]
> **`AGENT.md` is advisory only.** It cannot override, disable, or bypass any guardrail. Guardrails run on separate code paths that system-prompt text can't touch.

<a id="memory"></a>
### Local Memory (`memory.md`)

Enable memory from `/config` to let Sun2Agent retain explicit preferences between sessions. Memory lives locally and makes no model, embedding, telemetry, or memory-service requests.

- Editable memories live in `~/.sun2agent/memory.md`.
- `/memory` opens `memory.md` even when automatic memory is disabled.
- Local keyword relevance selects up to five memories; the full file is never injected.
- Explicit phrases such as "remember that…", "I prefer…", and "always…" can be saved automatically.
- Memory is contextual only and cannot override `AGENT.md`, guardrails, security policy, or Docker restrictions.

### Approved lessons from failures

After a clear tool error, failed Java test run, or unverified desktop action,
Sun2Agent may suggest one short operational lesson. **Save / Discard defaults to
Discard**; nothing is stored without your approval. Saved lessons live in the
owner-only `~/.sun2agent/lessons.json`, separate from `memory.md`. At most one
keyword-relevant lesson is added to a later task, as advisory context only.
Lesson drafting is local and makes no extra model or network call; it never
edits code, `AGENT.md`, guardrails, or approval settings.

<a id="ai-agent-skills"></a>
### AI Agent Skills (`skills.md`)

Skills are reusable instruction blocks you write once and toggle onto the agent whenever you need them — a coding style, a review checklist, a writing voice. They live in `~/.sun2agent/skills.md`.

**1. Write skills.** Run `/skills` → **Add/Edit Skills**. Each skill is a `## Name` heading followed by instructions:

```markdown
## Code Review

When reviewing code:
- Check error handling first, then edge cases, then style.
- Always run the test suite before approving.
```

**2. Select skills.** Run `/skills` → **Select Skills**. Active Skills appear as tags under the input box:

```text
[Skill: Code Review]  [Skill: Security Audit]
```

**3. Detach when done.** Press `Esc` on an empty input box to clear selected Skills and return to plain chat.

- Selected Skills are injected into the system prompt after `AGENT.md` and before memory.
- Skills are per-user (shared across projects); `AGENT.md` is per-project.

> [!NOTE]
> `Esc` on an empty input box does double duty: it disconnects the active MCP server first if one is connected, otherwise it clears selected Skills.

---

<a id="hitl"></a>
## Human-in-the-Loop

```text
AI Agent
    │
    ▼
Proposed Tool Call
    │
    ▼
Human Approval
    │
 ┌──┴──────────┐
 ▼             ▼
Allow      Don't allow
 │             │
 ▼             ▼
Execute      Skipped
```

Routine-change approval lasts only for the current prompt and MCP server. High-risk actions require fresh approval.

---

<a id="security--guardrails"></a>
## Security & Guardrails

Every MCP tool call passes through **five layers of guards** first — plain pattern matching, no extra model calls, no measurable latency.

```text
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
| **commandGuard** | `rm -rf`, `sudo`, `mkfs`, `dd if=`, fork bombs, `curl \| sh`, reverse shells, `git push --force` |
| **networkGuard** | Data exfiltration (`cat .env \| curl`), uploads (`curl -d`, `scp`, `nc`) |
| **filesystemGuard** | `.env`, `.ssh`, `.aws`, `id_rsa`, `*.pem`, path traversal, anything outside the project root |
| **outputGuard** | Masks API keys, AWS/GitHub/Slack tokens, JWTs, and private keys in tool output |

All policy lives in one file — [`src/core/guardrails/guardConfig.js`](https://github.com/snowhypers/Sun2Agent/blob/main/src/core/guardrails/guardConfig.js). Notable knobs:

- `projectRoot` — the filesystem sandbox, defaulting to the launch directory.
- `strictDomains` — off by default; restricts outbound URLs to `allowedDomains` when enabled.

```bash
npm test
```

### Security & trust

- **Your keys stay local** in `~/.sun2agent/` with owner-only permissions, never bundled with the package.
- **MCP child processes get a clean environment** — only a safe allowlist (`PATH`, `HOME`, …) is passed to `stdio` servers.
- **`mcp.json` can launch programs** — treat it like a shell script; only add servers you trust.
- **Guards reduce risk; they don't eliminate it.** A novel phrasing can get through pattern matching.
- **`AGENT.md` and Skills are advisory only** — neither can bypass a guardrail or Docker restriction.

---

<a id="docker-sandbox"></a>
## Optional Docker Sandbox

Run the **entire agent** — chat loop, guardrails, LLM calls, MCP client — inside an isolated container. Only your project directory and the agent's own config are visible; nothing else on your machine is reachable.

```bash
sun2agent sandbox enable     # turn it on (checks Docker first)
sun2agent sandbox status     # see current mode
sun2agent sandbox disable    # back to running on the host
```

- **No silent fallback** — if Docker isn't running, Sun2Agent tells you and exits.
- **Survives outages** — your conversation is saved after every exchange and resumes when Docker comes back.
- **Root is refused** — launching from `/` is blocked.

---

<a id="web-search"></a>
## Web Search

Off by default. Enable it in `/config` (or set `TAVILY_API_KEY`) for `web_search` via [Tavily](https://tavily.com)'s free tier — useful for current events and recent software versions.

---

<a id="observability"></a>
## Observability

Optionally trace LLM calls and MCP tool execution with LangSmith:

1. Run `/config`.
2. After choosing a model, answer `Yes` to **Enable LangSmith observability?**.
3. Paste your LangSmith API key when prompted.

Key points:

- **Off by default.**
- Traced content is **sanitized with the output guard** before it is sent — API keys and tokens are masked, never uploaded.
- LangSmith credentials are stored in `~/.sun2agent/config.json` with owner-only permissions.
- Disable any time by re-running `/config`.

---

<a id="requirements"></a>
## Requirements

- Node.js 20 or 22+
- An [NVIDIA NIM](https://build.nvidia.com) API key (`nvapi-...`) or credentials for an OpenAI-compatible endpoint
- Optional: MCP servers you want to connect
- Optional: [Docker](https://www.docker.com) for sandboxing

```bash
node --version
```

---

<a id="development"></a>
## Development

```bash
git clone https://github.com/snowhypers/Sun2Agent.git
cd Sun2Agent
npm install
npm start
npm test
```

---

<a id="troubleshooting"></a>
## Troubleshooting

**Tools are listed but the model never calls them**
Some models tool-call more reliably than others. Try a different model with `/config`, or name the tool explicitly.

**`/agent` doesn't open the file**
Run `npm link` from the project directory so the global `sun2agent` command points at your working copy.

**More help:** open an issue at [github.com/snowhypers/Sun2Agent/issues](https://github.com/snowhypers/Sun2Agent/issues).

---

<a id="uninstall"></a>
## Uninstall

```bash
sun2agent delete            # optional: remove saved config + mcp.json
npm uninstall -g sun2agent
```

---

<a id="contributing"></a>
## Contributing & Project Status

**Status:** Public, open source, actively maintained
**Maintainer:** Pradip — [Sun2Agent](https://github.com/snowhypers/Sun2Agent)
**Pull requests:** Not being accepted yet. Sun2Agent is currently a solo-built project, and the focus right now is on stability, core features, growing the user base, and fixing real bugs before opening up the codebase to outside changes.

You don't need to touch a line of code to help — right now the most useful contributions are:

| | How to help |
|---|---|
|  | **Report a bug** → [open an issue](https://github.com/snowhypers/Sun2Agent/issues) |
|  | **Suggest a feature** → [open an issue](https://github.com/snowhypers/Sun2Agent/issues) |
|  | **Ask a question or share feedback** → [start a discussion](https://github.com/snowhypers/Sun2Agent/discussions) |
|  | **Star the repo** → [github.com/snowhypers/Sun2Agent](https://github.com/snowhypers/Sun2Agent/stargazers) — the single biggest thing that helps other developers find it |
| | **Share it** → a tweet, a Reddit post, a Show HN, or just telling another developer |

Community pull requests will open in a later phase once the core is stable. For now, **issues and discussions are the best way to contribute.**

---

<a id="faq"></a>
## ❓ FAQ

**Is Sun2Agent free?**
Yes — [MIT-licensed](https://github.com/snowhypers/Sun2Agent/blob/main/LICENSE) and free. You only pay for usage charged by your selected model provider.

**Does Sun2Agent send my data anywhere?**
Only to the model provider you select, and optionally to LangSmith, Tavily, or Telegram if you enable them yourself. Config, memory, and Skills stay local with zero telemetry. Provider and Telegram credentials are stored in the owner-only `~/.sun2agent/config.json` file.

**What's the difference between Sun2Agent and a desktop MCP client?**
A lightweight terminal CLI — no IDE required — with built-in destructive-command guardrails, risk-based human approval, and an optional Docker sandbox.

**Can I use my own MCP servers?**
Yes. Any `stdio`, `http`, or `sse` MCP server can be added to `~/.sun2agent/mcp.json`.

**Does it work with models other than NVIDIA NIM?**
Yes. NVIDIA NIM remains built in, and `/config` can save and select multiple OpenAI-compatible providers and model IDs. Tool use depends on whether the selected model implements OpenAI-compatible tool calling.

**Does Sun2Agent require Docker?**
No — Docker sandboxing is entirely optional.

**What's the difference between AGENT.md, memory, and Skills?**
`AGENT.md` is per-project and repo-scoped; memory and Skills are per-user and follow you across projects. Memory is preferences the agent remembers automatically; Skills are instruction blocks you write and toggle on deliberately.

**Is Sun2Agent a good Claude Code or Codex CLI alternative?**
It solves a related but different problem: Sun2Agent is MCP-first and works with NVIDIA NIM or custom OpenAI-compatible providers, with guardrails on every call and human approval for mutating or unknown tools. See the [comparison table](#vs-alternatives) above.

---

<a id="license"></a>
## 📜 License

[MIT](https://github.com/snowhypers/Sun2Agent/blob/main/LICENSE) — free for personal and commercial use.

---

<div align="center">

### ☀️ Sun2Agent

**Your terminal. Your MCP servers. One safe AI agent.**

[npm](https://www.npmjs.com/package/sun2agent) · [GitHub](https://github.com/snowhypers/Sun2Agent) · [Issues](https://github.com/snowhypers/Sun2Agent/issues) · [Discussions](https://github.com/snowhypers/Sun2Agent/discussions) · [Star it](https://github.com/snowhypers/Sun2Agent/stargazers)

**Keywords:** AI agent CLI · terminal AI agent · MCP client · Model Context Protocol npm · open source AI agent · secure AI agent · autonomous coding agent · NVIDIA NIM · OpenAI-compatible API · LLM tool calling · Docker sandboxed agent · developer AI tools · CLI chatbot · agentic terminal · human-in-the-loop AI · self-hosted AI agent · Claude Code alternative · Codex CLI alternative

</div>
