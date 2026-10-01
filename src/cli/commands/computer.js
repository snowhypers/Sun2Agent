const chalk = require('chalk');
const ora = require('ora');
const mcp = require('../../core/mcp');
const computer = require('../../core/mcp/computer');
const sandbox = require('../../core/sandbox');
const { watchEscape } = require('../ui/escapeWatcher');

async function disconnectComputer() {
  await mcp.disconnectComputer();
  console.log(chalk.gray('\n⎋ Disconnected /computer. Other plugins remain unchanged.\n'));
}

async function handleComputer(ctx) {
  if (mcp.isComputerConnected()) {
    console.log(chalk.green('\n✔ /computer is already connected. Esc on empty input goes back.\n'));
    return;
  }
  if (sandbox.inSandbox() || sandbox.isSandboxEnabled()) {
    console.log(chalk.yellow('\n/computer needs a host desktop; it cannot control your host through the Docker sandbox.\n'));
    return;
  }
  const consent = await ctx.promptBack([{
    type: 'confirm', name: 'allow', default: false,
    message: 'Connect real desktop control (not isolated)? Esc to go back'
  }]);
  if (!consent?.allow) return;
  const mode = await ctx.promptBack([{
    type: 'confirm', name: 'vision', default: false,
    message: 'Does your selected model support images? Screenshots may be sent to your model provider.'
  }]);
  if (!mode) return;
  const spinner = ora('Connecting /computer (first use may download the package; 30s timeout)…').start();
  const connectionAbort = new AbortController();
  const stopConnecting = watchEscape(() => connectionAbort.abort());
  let result;
  try { result = await mcp.connectComputer(connectionAbort.signal); }
  finally { stopConnecting(); spinner.stop(); }
  if (!result.ok) {
    console.log(chalk.red(`\n✗ Computer connection failed: ${result.error}\n`));
    return;
  }
  computer.setVision(mode.vision);
  const { routes } = mcp.getOpenAiTools();
  const doctor = [...routes].find(([, route]) => route.server === 'computer' && route.tool === 'doctor');
  if (doctor) {
    const controller = new AbortController();
    const stop = watchEscape(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const report = await mcp.callTool(routes, doctor[0], {}, controller.signal);
      console.log(require('../../core/guardrails').outputGuard(String(report)).slice(0, 3000));
    } catch (error) {
      if (controller.signal.aborted) {
        await disconnectComputer();
        console.log(chalk.yellow('Desktop check stopped or timed out.'));
        return;
      }
      console.log(chalk.yellow(`Desktop check failed: ${error.message}`));
    } finally { clearTimeout(timer); stop(); }
  }
  console.log(chalk.green('\n✔ /computer connected. Check the permission report above before acting.'));
  console.log(chalk.gray(`Mode: ${mode.vision ? 'vision + accessibility' : 'accessibility (no screenshot uploads)'}. Esc stops a task; Esc on empty input disconnects.\n`));
}
module.exports = { handleComputer, disconnectComputer };
