// /mcp slash command — 3-option menu: open mcp.json, connect a server, or
// go back to chat. The two sub-actions (add/edit, connect) are private to
// this file since they share the same `ctx` and are not part of the public
// command surface.

const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const mcp = require('../../core/mcp');
const { getMcpFilePath, openMcpConfig, loadMcpConfig, getServers } = require('../../core/mcp/config');

async function mcpAddEdit(ctx) {
  const file = getMcpFilePath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'Add servers under "mcpServers". See "_examples" in the file for local (stdio)\n' +
        'and remote (http / sse) formats.\n'
    )
  );
  openMcpConfig();
  // GUI editors return immediately, so wait for the user to finish saving.
  // Enter = done, Esc = back to chat (uses our own reliable key reader).
  const key = await ctx.waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved mcp.json, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back to simple chat... ')
  );
  if (key === 'escape') {
    // Esc -> back to simple chat, disconnecting any active MCP server.
    if (mcp.getActiveName()) {
      await mcp.disconnectAll();
      console.log(chalk.gray('\nDisconnected MCP. Back to simple chat.\n'));
    } else {
      console.log(chalk.gray('\nBack to simple chat.\n'));
    }
    return;
  }
  console.log(chalk.green('✔ mcp.json ready. Choose "Connect MCP" to connect.\n'));
}

// --- MCP: option 2 -> list servers, pick ONE, connect it, show its tag ---
async function mcpConnect(ctx) {
  // Catch a broken mcp.json up front so the user sees *why* nothing loads
  // instead of a misleading "no servers defined" message.
  const cfg = loadMcpConfig();
  if (cfg._parseError) {
    console.log(chalk.red('\n✗ mcp.json is not valid JSON: ') + chalk.yellow(cfg._parseError));
    console.log(chalk.gray(`   File: ${getMcpFilePath()}`));
    console.log(
      chalk.gray('   Fix the JSON (use "Add / Edit MCP") — each server is a flat\n') +
        chalk.gray('   "name": { ... } pair with no extra { } around it.\n')
    );
    return;
  }

  const servers = getServers();
  if (servers.length === 0) {
    console.log(
      chalk.yellow('\nNo servers defined in mcp.json yet. Use "Add / Edit MCP" first.\n')
    );
    return;
  }

  // Which servers are connected right now, and are they ALL connected?
  const connectedNames = new Set(mcp.getConnections().map((c) => c.name));
  const allConnected = servers.length > 1 && connectedNames.size === servers.length;
  const connectedTag = chalk.green('  ● connected');

  // Show the list of available servers and let the user pick one (or all).
  const ans = await ctx.promptBack([
    {
      type: 'list',
      name: 'choice',
      message: 'Select an MCP server to chat with:  ' + chalk.gray('(esc to go back)'),
      pageSize: Math.min(servers.length + 4, 15),
      loop: false,
      choices: [
        {
          name:
            chalk.bold('Connect all MCPs') +
            chalk.gray(`  (all ${servers.length} servers together)`) +
            (allConnected ? connectedTag : ''),
          value: '__all__'
        },
        { name: 'Disconnect (chat without any MCP)', value: '__disconnect__' },
        new inquirer.Separator(),
        ...servers.map((s) => ({
          name:
            `${s.name}  ${chalk.gray('[' + s.type + ']')}` +
            (!allConnected && connectedNames.has(s.name) ? connectedTag : ''),
          value: s.name
        }))
      ]
    }
  ]);
  if (!ans) return; // esc -> back to chat
  const choice = ans.choice;

  if (choice === '__disconnect__') {
    await mcp.disconnectAll();
    console.log(chalk.gray('\nDisconnected. No MCP server is active.\n'));
    return;
  }

  // Connect ALL servers at once -> tag becomes @allMcps, all tools available.
  if (choice === '__all__') {
    const spinner = ora('Connecting to all MCP servers...').start();
    const results = await mcp.connectAll();
    spinner.stop();
    console.log(chalk.bold('\nConnecting all MCP servers:\n'));
    let totalTools = 0;
    for (const r of results) {
      if (r.ok) {
        totalTools += r.toolCount;
        console.log(chalk.green('  ✔ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) + chalk.cyan(`${r.toolCount} tool(s)`));
      } else {
        console.log(chalk.red('  ✗ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) + chalk.red('failed: ' + r.error));
      }
    }
    const ok = results.filter((r) => r.ok).length;
    if (ok > 0) {
      console.log(
        chalk.green(`\n✔ Connected ${ok}/${results.length} server(s) as `) +
          chalk.bold('@allMcps') +
          chalk.cyan(` — ${totalTools} tools available.`) +
          chalk.gray('\nJust ask; the agent will pick the right tool from any server.\n')
      );
    } else {
      console.log(chalk.red('\n✗ No servers connected.'));
      // If Docker went down, tell the user clearly instead of leaving them
      // to guess why every stdio server failed.
      const dockerWarn = ctx.dockerDownWarning();
      if (dockerWarn) {
        console.log(chalk.red('⛔ ' + dockerWarn));
      }
      console.log();
    }
    return;
  }

  const spinner = ora(`Connecting to ${choice}...`).start();
  let r;
  try {
    r = await mcp.connectSelected(choice);
  } catch (e) {
    spinner.stop();
    console.log(chalk.red('Failed to connect: ' + e.message));
    // If Docker went down, tell the user clearly.
    const dockerWarn = ctx.dockerDownWarning();
    if (dockerWarn) {
      console.log(chalk.red('⛔ ' + dockerWarn));
    }
    console.log();
    return;
  }
  spinner.stop();

  if (r.ok) {
    const toolNames = r.tools.map((t) => t.name).join(', ') || '(no tools)';
    console.log(
      chalk.green('\n✔ Connected ') +
        chalk.bold('@' + r.name) +
        chalk.gray(` [${r.type}] `) +
        chalk.cyan(`${r.toolCount} tool(s): `) +
        chalk.gray(toolNames)
    );
    console.log(chalk.gray('You are now chatting with this server. Its tools are available.\n'));
  } else {
    console.log(
      chalk.red('\n✗ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) +
        chalk.red('failed: ' + r.error) + '\n'
    );
  }
}

async function handleMcp(ctx) {
  const ans = await ctx.promptBack([
    {
      type: 'list',
      name: 'action',
      message: 'MCP servers:  ' + chalk.gray('(esc to go back)'),
      choices: [
        { name: 'Add / Edit MCP  (open mcp.json)', value: 'add' },
        { name: 'Connect MCP  (select a server to chat with)', value: 'connect' },
        { name: 'Not connect  (back to chat)', value: 'back' }
      ]
    }
  ]);
  if (!ans) return; // esc -> back to chat

  if (ans.action === 'add') await mcpAddEdit(ctx);
  else if (ans.action === 'connect') await mcpConnect(ctx);
  // 'back' just returns to the chat loop
}

module.exports = { handleMcp };
