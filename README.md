# ☀️ sun2Agent

A simple terminal AI chat agent with a **native MCP client** — connect to any [Model Context Protocol](https://modelcontextprotocol.io) server (local or remote) and let the agent use its tools to automate tasks. Powered by the [NVIDIA NIM](https://build.nvidia.com) API.

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

## Demo

▶️ **[Watch the demo](https://www.loom.com/share/c5d96ba1ab2942de91cd9081883391dd)** — connecting an MCP server and letting the agent drive its tools.

## Features

- 💬 Terminal chat with NVIDIA NIM models
- 🔌 Built-in MCP client — connect **stdio** (local) and **remote** (HTTP / SSE) servers
- 🧰 Connect one server, or **all servers at once** (`@allMcps`) and let the agent pick the right tool
- ⚙️ Automatic tool-calling based on your prompt
- ⌨️ Clean TUI: rounded input box, live tags, `Esc` to interrupt

## Install

sun2Agent is a command-line tool, so install it **globally** (note the `-g`):

```bash
npm install -g sun2agent
sun2agent
```

Or run it **without installing anything**, using npx:

```bash
npx sun2agent
```

Requires **Node.js >= 18**.

> ⚠️ Don't run `npm install sun2agent` (without `-g`) inside another project — that
> adds it as a local dependency and re-resolves *that project's* packages, which can
> fail with peer-dependency errors that have nothing to do with sun2Agent. Use `-g`
> or `npx` instead.

## First run

1. Start it: `sun2agent`
2. Run `/config`, paste your **NVIDIA NIM API key** (get one free at [build.nvidia.com](https://build.nvidia.com) -> pick a model -> *Get API Key*, it starts with `nvapi-`), and choose a model.
3. Start chatting.

## Commands

| Command | Action |
|---------|--------|
| `/help`, `/?` | Show all commands and shortcuts |
| `/config` | Set your NVIDIA NIM API key and choose a model |
| `/mcp` | Manage MCP servers (add/edit, connect one or all, disconnect) |
| `/delete` | Delete saved config and data |
| `/exit` | Quit |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` (while typing) | Clear the input |
| `Esc` (empty box) | Disconnect MCP and return to simple chat |
| `Esc` (while the agent works) | Stop the current reply / tool call |
| `Esc` (in menus) | Go back / cancel |
| `Ctrl+C` | Quit immediately |

## Using MCP servers

Run `/mcp` -> **Add / Edit MCP** to open `~/.sun2agent/mcp.json`. Add servers under `mcpServers`:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
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

Supported `type` values: `stdio` (local process), `http` (Streamable HTTP, alias `remote`), `sse`.

Then `/mcp` -> **Connect MCP** -> pick a server (or **Connect all MCPs**). The active server shows as a green `@tag` under the input box, and its tools become available to the agent automatically — just ask.

## Security & trust

- Your API key and `mcp.json` are stored locally in `~/.sun2agent/` (owner-only permissions). They are never bundled with the package.
- **`mcp.json` can launch programs.** A `stdio` server runs the `command` you specify — treat `mcp.json` like a script and only add servers you trust.
- **Tools run automatically.** The agent executes MCP tools based on the model's decisions without a confirmation prompt. Be cautious connecting servers that fetch untrusted web content *and* servers that can take destructive actions in the same session.

## Uninstall

```bash
sun2agent delete            # optional: remove saved config + mcp.json
npm uninstall -g sun2agent
```

## License

MIT
