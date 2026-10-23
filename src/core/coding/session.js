const path = require('path');
const { CODING_BROWSER_PROMPT, hasPlanHeading, missingVerification, selectCodingBrowserTools } = require('./workflow');

const INSPECTION_TOOLS = new Set([
  'directory_tree', 'list_allowed_directories', 'list_directory', 'read_file',
  'read_media_file', 'read_multiple_files', 'read_text_file', 'search_files', 'get_file_info'
]);
const CHANGE_TOOLS = new Set([
  'create_directory', 'write_file', 'edit_file', 'delete_file', 'delete_directory',
  'move_file', 'install_project_dependencies', 'run_project_check', 'run_maven_tests',
  'start_project_server', 'curl_local_api'
]);

function createSession(enabled, task = '', approvedPlan = false) {
  // Use the actual task headline, not quoted requirements/examples lower in
  // the message, to avoid demanding API/UI checks for an unrelated code fix.
  const taskText = String(task).split(/\r?\n/, 1)[0];
  const action = '(?:add|build|check|create|debug|develop|edit|fix|implement|make|modify|refactor|run|test|upgrade|write)';
  const changeRequested = /\b(?:add|build|create|debug|develop|edit|fix|implement|make|modify|refactor|upgrade|write)\b/i.test(taskText);
  const taskTargets = (target) => new RegExp(
    `\\b${action}\\s+(?:[\\w./-]+\\s+){0,8}(?:${target})\\b|` +
    `\\b(?:${target})\\s+(?:[\\w./-]+\\s+){0,8}${action}\\b`, 'i'
  ).test(taskText);
  const verificationTypes = [];
  if (taskTargets('api|backend|endpoint|full[\\s-]?stack')) verificationTypes.push('api');
  if (taskTargets('frontend|front[\\s-]?end|html|website|web[\\s-]?app|ui|user interface|page|full[\\s-]?stack|react|vue|angular|svelte|next(?:js)?|nuxt|vite|client|spa|dashboard|todo')) {
    verificationTypes.push('browser');
  }
  const gitignoreVerificationRequired = taskTargets('git|gitignore') ||
    /\b(?:create|init|bootstrap)\s+(?:new\s+)?(?:repo|repository|project|app)\b/i.test(taskText);
  const state = { filesWritten: false, changeRequested, workspaceChanged: false, changesDeclined: false,
    installRequired: false, installed: false,
    installedPaths: new Set(), installRequiredPaths: new Set(),
    testsConfigured: null, testsPassed: false, serverStarted: false, serverPurpose: null,
    serverPurposes: new Set(),
    serverRestartRequested: false,
    serverStartFailed: false, serverPortConflict: false, serverStartAttempts: 0,
    apiSmokeAttempted: false, apiSmokePassed: false,
    apiSmokeDeclined: false, verificationTypes, workspaceInspected: false, planShown: approvedPlan,
    serverStartDeclined: false, browserSmokeChecked: false, installDeclined: false, testsDeclined: false,
    browserTestDeclined: false, browserNavigated: false, browserActionObserved: false,
    browserErrors: false,
    envChecked: false, gitignoreChecked: false, gitignoreVerificationRequired, curlAttempts: 0,
    nudgeUsed: false };

  function recordToolResult(route, args, raw) {
    if (!enabled || !route) return false;
    if (/^(?:Tool error:|MCP tool reported an error:)/i.test(String(raw || '').trim())) {
      if (route.server === 'coding-browser' &&
          ['browser_navigate', 'browser_click', 'browser_fill_form', 'browser_type', 'browser_press_key'].includes(route.tool)) {
        state.browserNavigated = route.tool === 'browser_navigate' ? false : state.browserNavigated;
        state.browserActionObserved = false;
        state.browserSmokeChecked = false;
        state.browserErrors = true;
      }
      return false;
    }
    if (/NOT executed/i.test(raw)) {
      if (route.server === 'workspace' && route.tool === 'install_project_dependencies') state.installDeclined = true;
      if (route.server === 'workspace' && ['create_directory', 'write_file', 'edit_file',
          'delete_file', 'delete_directory', 'move_file'].includes(route.tool)) state.changesDeclined = true;
      if (route.server === 'workspace' && (route.tool === 'run_maven_tests' ||
          route.tool === 'run_project_check')) {
        state.testsDeclined = true;
      }
      if (route.server === 'workspace' && route.tool === 'curl_local_api') {
        state.apiSmokeDeclined = true;
        return state.verificationTypes.includes('browser') && state.serverPurposes.has('frontend');
      }
      if (route.server === 'workspace' && route.tool === 'start_project_server') {
        state.serverStartDeclined = true;
      }
      if (route.server === 'coding-browser' && /human declined approval|approval is required/i.test(raw)) {
        state.browserTestDeclined = true;
      }
      return false;
    }
    if (route.server === 'workspace') {
      const packageManifestChanged = ['write_file', 'edit_file', 'delete_file', 'move_file'].includes(route.tool) &&
        [args.path, args.source, args.destination, args.new_path]
          .some((filePath) => typeof filePath === 'string' && /(?:^|[\\/])package\.json$/i.test(filePath));
      const changed = ['create_directory', 'write_file', 'edit_file', 'delete_file',
        'delete_directory', 'move_file', 'install_project_dependencies'].includes(route.tool);
      if (changed) {
        state.testsPassed = false;
        state.apiSmokeAttempted = false;
        state.apiSmokePassed = false;
        state.browserSmokeChecked = false;
        state.browserNavigated = false;
        state.browserActionObserved = false;
        state.browserErrors = false;
        // Reset port-conflict / start-failure flags so the agent can retry after a code change
        state.serverStartFailed = false;
        state.serverPortConflict = false;
        state.serverStartAttempts = 0;
        if (state.serverStarted) {
          state.serverStarted = false;
          state.serverPurpose = null;
          state.serverPurposes.clear();
          state.serverRestartRequested = true;
        }
      }
      const touchedFiles = [args.path, args.source, args.destination, args.new_path]
        .filter((filePath) => typeof filePath === 'string');
      if (touchedFiles.some((f) => /(?:^|[\\/])\.gitignore$/i.test(f))) {
        state.gitignoreChecked = true;
      }
      if (touchedFiles.some((f) => /(?:^|[\\/])\.env(?:\.example)?$/i.test(f))) {
        state.envChecked = true;
      }
      if (INSPECTION_TOOLS.has(route.tool)) state.workspaceInspected = true;
      if (['create_directory', 'write_file', 'edit_file', 'delete_file',
          'delete_directory', 'move_file'].includes(route.tool)) state.workspaceChanged = true;
      if (['write_file', 'edit_file'].includes(route.tool)) {
        state.filesWritten = true;
      }
      if (packageManifestChanged) {
        state.installRequired = true;
        state.installed = false;
        for (const filePath of [args.path, args.source, args.destination, args.new_path]) {
          if (typeof filePath === 'string' && /(?:^|[\\/])package\.json$/i.test(filePath)) {
            const dir = path.dirname(filePath).replace(/\\/g, '/').replace(/^\.\/?/, '') || '.';
            state.installRequiredPaths.add(dir);
            state.installedPaths.delete(dir);
          }
        }
      }
      if (route.tool === 'install_project_dependencies' &&
          /Dependencies COMPLETED\.|Dependency install skipped:/i.test(raw)) {
        state.installed = true;
        state.installRequired = false;
        const target = (args.path || args.projectPath || args.directory || args.dir || args.cwd || '.')
          .replace(/\\/g, '/').replace(/^\.\/?/, '') || '.';
        state.installedPaths.add(target);
        state.installRequiredPaths.delete(target);
      }
      if (route.tool === 'run_project_check' &&
          ['test', 'test:api', 'test:backend'].includes(args.script)) {
        if (/Project check .* PASSED\./i.test(raw)) {
          state.testsConfigured = true;
          state.testsPassed = true;
        } else if (/Project check NOT CONFIGURED:/i.test(raw)) {
          state.testsConfigured = false;
          state.testsPassed = false;
        } else if (/Project check .* (?:FAILED|NOT VERIFIED)\b/i.test(raw)) {
          state.testsConfigured = true;
          state.testsPassed = false;
        }
      }
      if (route.tool === 'run_maven_tests') {
        state.testsConfigured = true;
        state.testsPassed = /Maven tests PASSED\./i.test(raw);
      }
      if (route.tool === 'curl_local_api') {
        state.curlAttempts = (state.curlAttempts || 0) + 1;
        state.apiSmokeAttempted = true;
        state.apiSmokePassed = /Local API check PASSED:/i.test(raw);
        return state.apiSmokePassed && state.verificationTypes.includes('browser') &&
          state.serverPurposes.has('frontend');
      }
      if (route.tool === 'start_project_server') {
        state.serverStartAttempts = (state.serverStartAttempts || 0) + 1;
        if (/^Project server reported https?:\/\//i.test(raw)) {
          state.serverStarted = true;
          state.serverStartFailed = false;
          state.serverPortConflict = false;
          state.serverPurpose = args.purpose === 'api' ? 'api' : 'frontend';
          state.serverPurposes.add(state.serverPurpose);
          if (state.serverPurpose === 'frontend' && !state.verificationTypes.includes('browser')) {
            state.verificationTypes.push('browser');
          }
          return state.serverPurpose === 'frontend' &&
            (!state.verificationTypes.includes('api') || state.apiSmokePassed || state.apiSmokeDeclined);
        }
        if (/port already in use|EADDRINUSE/i.test(raw)) {
          state.serverStartFailed = true;
          state.serverPortConflict = true;
        } else if (/FAILED|NOT READY|NOT STARTED|exited before/i.test(raw)) {
          state.serverStartFailed = true;
        }
      }
    }
    if (route.server === 'coding-browser') {
      if (['browser_console_messages', 'browser_network_requests', 'browser_snapshot'].includes(route.tool)) {
        const failed = /(?:Errors:\s*[1-9]\d*|Console:\s*[1-9]\d*\s+errors|Failed to load resource|net::ERR_|\b(?:HTTP\s*)?[45]\d\d\b)/i.test(raw);
        if (failed) {
          state.browserErrors = true;
          state.browserSmokeChecked = false;
        } else if (route.tool !== 'browser_snapshot' || /Console:\s*0\s+errors/i.test(raw)) {
          state.browserErrors = false;
        }
      }
      if (route.tool === 'browser_navigate' &&
          typeof args.url === 'string' &&
          /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(args.url) &&
          /Page URL:\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i.test(raw)) {
        state.browserNavigated = true;
        state.browserActionObserved = false;
        state.browserErrors = false;
      }
      if (state.browserNavigated &&
          ['browser_click', 'browser_fill_form', 'browser_type', 'browser_press_key'].includes(route.tool)) {
        state.browserActionObserved = true;
      }
      if (route.tool === 'browser_snapshot' && !state.browserErrors && state.browserActionObserved &&
          /Page URL:\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i.test(raw) &&
          /(?:Page Title:|Page Snapshot:|generic|heading|button|link|textbox|paragraph)/i.test(raw)) {
        state.browserSmokeChecked = true;
      }
    }
    return false;
  }

  async function connectBrowser({ mcp, routes, specs, system, updateTools }) {
    const browser = await mcp.connectCodingBrowser();
    if (!browser.ok) {
      system.content += '\nPlaywright could not start. Continue without it and report browser testing as not run.';
      return { ok: false, error: browser.error };
    }
    const connected = mcp.getOpenAiTools();
    for (const spec of selectCodingBrowserTools(connected.specs, connected.routes)) {
      const route = connected.routes.get(spec.function.name);
      if (!routes.has(spec.function.name)) {
        routes.set(spec.function.name, route);
        specs.push(spec);
      }
    }
    system.content += CODING_BROWSER_PROMPT;
    updateTools();
    return { ok: true };
  }

  function beforeFinish(message, allowTools, system) {
    if (!enabled) return { retry: false };
    const missing = missingVerification(state);
    if (missing.length && !state.nudgeUsed && allowTools) {
      state.nudgeUsed = true;
      system.content += `\nCoding verification gate: do not finish yet. Complete these missing steps: ${missing.join('; ')}. If a step cannot be completed, report it as unverified.`;
      return { retry: true, missing };
    }
    if (missing.length) {
      const notice = `\n\nNot confirmed: ${missing.join('; ')}. ` +
        'No passing result was recorded; do not treat this task as complete or verified.';
      if (!String(message.content || '').includes('Not confirmed:')) {
        message.content = `Task incomplete: ${message.content || 'Requested work is not verified.'}${notice}`;
      }
    }
    return { retry: false, missing };
  }

  function notePlan(message, inspectedBeforeResponse) {
    if (enabled && hasPlanHeading(message?.content)) {
      state.planShown = true;
    }
  }

  function authorizeTool(route, message, inspectedBeforeResponse, args = {}) {
    if (enabled && route?.server === 'coding-browser' &&
        state.verificationTypes.includes('api') && !state.apiSmokePassed && !state.apiSmokeDeclined) {
      return { allowed: false, reason: 'Complete the backend API check before using Playwright for this full-stack task.' };
    }
    if (!enabled || route?.server !== 'workspace' || !CHANGE_TOOLS.has(route.tool)) return { allowed: true };
    if (route.tool === 'install_project_dependencies') {
      const target = (args.path || args.projectPath || args.directory || args.dir || args.cwd || '.')
        .replace(/\\/g, '/').replace(/^\.\/?/, '') || '.';
      if (state.installedPaths.has(target) && !state.installRequiredPaths.has(target)) {
        return { allowed: false, reason: `Dependencies are already installed in ${target}. Do not reinstall dependencies; proceed to run configured checks or verify the project.` };
      }
    }
    if (route.tool === 'curl_local_api' && state.curlAttempts >= 3) {
      return { allowed: false, reason: 'The local API smoke-test requests reached the limit (3). Report results; rerun only after changing the project.' };
    }
    if (route.tool === 'start_project_server' && state.serverPortConflict) {
      return { allowed: false, reason: 'The server failed with EADDRINUSE (port already in use). Ask the user to free the port or change the port in the project code, then retry. Do not repeat start_project_server without a code change.' };
    }
    if (route.tool === 'start_project_server' && state.serverStartAttempts >= 2 && !state.serverStarted) {
      return { allowed: false, reason: 'The server failed to start twice. Report the failure and ask the user for guidance instead of retrying.' };
    }
    if (route.tool === 'start_project_server' && state.apiSmokeAttempted && args.purpose === 'api') {
      return { allowed: false, reason: 'The API smoke test already ran. Change the project before starting it again.' };
    }
    if (!inspectedBeforeResponse) {
      return { allowed: false, reason: 'Inspect the workspace first, then show a short task-specific plan before changing files or running setup.' };
    }
    if (state.planShown) return { allowed: true };
    if (!hasPlanHeading(message?.content)) {
      return { allowed: false, reason: 'Show a short task-specific “Plan:” in assistant text before the first workspace change or setup action.' };
    }
    state.planShown = true;
    return { allowed: true };
  }

  function takeServerRestartRequest() {
    const requested = state.serverRestartRequested;
    state.serverRestartRequested = false;
    return requested;
  }

  function shouldStopProjectServer() {
    return state.serverStarted && state.serverPurposes.has('api') &&
      !state.verificationTypes.includes('browser') && state.apiSmokeAttempted;
  }

  function markProjectServerStopped() {
    state.serverStarted = false;
    state.serverPurpose = null;
    state.serverPurposes.clear();
  }

  return { recordToolResult, connectBrowser, beforeFinish, authorizeTool, notePlan,
    hasInspectedWorkspace: () => state.workspaceInspected,
    hasWorkspaceChanges: () => state.workspaceChanged,
    shouldStopProjectServer, markProjectServerStopped,
    takeServerRestartRequest };
}

module.exports = { createSession };
