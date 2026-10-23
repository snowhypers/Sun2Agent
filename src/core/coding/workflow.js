function selectCodingTools(specs, routes, options = {}) {
  return specs.filter((spec) => {
    const route = routes.get(spec.function.name);
    if (route?.server !== 'workspace') return false;
    if (spec.function.name === 'run_maven_tests' || route?.tool === 'run_maven_tests') {
      if (!options.hasPomXml && !options.isJavaProject) {
        return false;
      }
    }
    return true;
  });
}

function hasPlanHeading(text) {
  return /^\s*(?:#{1,3}\s*)?(?:\*\*)?plan(?:\*\*)?(?:\s*:|\s*$|\s+\S)/im.test(String(text || ''));
}

function isToolPayload(text) {
  try {
    const value = JSON.parse(String(text || '').trim());
    return Boolean(value && typeof value === 'object' &&
      (typeof value.tool === 'string' || value.type === 'function' || value.function));
  } catch (_) {
    return false;
  }
}

function fallbackPlan(task) {
  const request = String(task || 'the requested change').replace(/\s+/g, ' ').trim();
  return `**Plan**\n\n1. **Inspect and structure** — After approval, inspect the workspace and follow its existing conventions; for a new project, use the smallest structure needed for “${request}”.\n2. **Implement the request** — Make the requested change: “${request}”, without adding unrelated features.\n3. **Verify** — Run relevant configured checks; use local curl for API work or Playwright for requested UI work, and report anything that cannot run.`;
}

function isCodingToolAllowed(name, offeredTools) {
  return Array.isArray(offeredTools) && offeredTools.some((tool) => tool.function?.name === name);
}

function isTestFilePath(filePath) {
  if (typeof filePath !== 'string') return false;
  const path = filePath.replace(/\\/g, '/');
  return /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/i.test(path) ||
    /(?:^|[/.])(?:[^/]+\.)?(?:test|spec)\.[^.]+$/i.test(path) ||
    /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(path) ||
    /(?:^|\/)(?:[^/]+Test|Test[^/]+)\.java$/i.test(path);
}

function progressLabel(tool, args = {}) {
  const target = typeof args.path === 'string' ? args.path
    : typeof args.projectPath === 'string' ? args.projectPath
    : typeof args.directory === 'string' ? args.directory
    : typeof args.dir === 'string' ? args.dir : '.';
  if (tool === 'install_project_dependencies') return `Installing dependencies in ${target}`;
  if (tool === 'create_directory') return `Creating folder ${target}`;
  if (tool === 'write_file') return `Writing ${target}`;
  if (tool === 'edit_file') return `Updating ${target}`;
  if (tool === 'run_project_check') return `Running ${args.script || 'project'} checks`;
  if (tool === 'curl_local_api') return 'Smoke-testing local API with curl';
  if (tool === 'start_project_server') return `Starting ${args.script || 'project'} server`;
  return null;
}

function formatCodingPlan() {
  return 'Coding mode: I’ll prepare a task-specific implementation plan without calling tools. After you approve it, I’ll inspect the workspace and implement it.';
}

function missingVerification(state) {
  const missing = [];
  if (state.changeRequested && !state.workspaceChanged && !state.changesDeclined) {
    missing.push('make the requested workspace changes');
  }
  if (state.workspaceChanged && state.gitignoreVerificationRequired && !state.gitignoreChecked && !state.changesDeclined) {
    missing.push('ensure .gitignore exists with node_modules/ and .env entries');
  }
  if (state.installRequired && !state.installed && !state.installDeclined) missing.push('install declared dependencies');
  if (state.filesWritten && state.testsConfigured === true && !state.testsPassed && !state.testsDeclined) {
    missing.push('run and pass the relevant project tests');
  }
  // Skip API/browser smoke gates when the server failed to start (EADDRINUSE, crash, etc.)
  // — the agent cannot satisfy these without user intervention.
  const serverBlocked = state.serverStartFailed || state.serverPortConflict;
  if ((state.verificationTypes?.includes('api') || (state.serverStarted && state.serverPurpose === 'api')) &&
      !state.apiSmokeAttempted && !state.apiSmokeDeclined && !state.serverStartDeclined && !serverBlocked) {
    missing.push('run the local API smoke test');
  } else if (state.apiSmokeAttempted && !state.apiSmokePassed && !state.apiSmokeDeclined) {
    missing.push('pass the local API smoke test');
  }
  if (((state.verificationTypes?.includes('browser')) ||
      (state.serverStarted && state.serverPurpose !== 'api')) &&
      !state.browserSmokeChecked && !state.browserTestDeclined && !state.serverStartDeclined && !serverBlocked) {
    missing.push(state.browserErrors
      ? 'fix local browser/network errors and rerun the Playwright interaction smoke check'
      : 'run a local Playwright interaction smoke check');
  }
  return missing;
}

const CODING_WORKFLOW_PROMPT =
  '\n\nCoding task workflow:\n' +
  '- Treat requests to create, build, implement, or write code as actions: use workspace tools to change the project; do not answer with instructions or paste the implementation instead.\n' +
  '- Before any tool call, return a task-specific, actionable plan—not a generic workflow summary. Use a “**Plan**” heading and ordered steps: (1) likely project structure as a small file tree with each file’s purpose, (2) implementation details and requested behavior/endpoints, (3) only necessary setup/dependencies, (4) relevant tests and verification, and (5) expected completion report. Tailor every item to the exact user prompt; state assumptions where the existing workspace must be inspected after approval, and never invent existing files or claim you inspected them. The plan must be readable Markdown, never JSON, tool names/arguments, or an imitation MCP call. For a request limited to a static HTML/CSS/JavaScript frontend, do not assume or create an API/backend, package.json, dependencies, endpoints, or curl test unless the user explicitly requests them or an existing project API must be integrated. For new Node APIs or full-stack backends, include a tests/ folder (e.g. tests/api.test.js or backend/tests/api.test.js) in the file tree for simple unit and health check tests, alongside package.json, server.js or src/index.js, and .gitignore; describe CRUD endpoints only if requested or clearly implied. Mention .env/.gitignore requirements, but include .env.example only when the app needs environment variables. Propose minimal tests when relevant, label optional test-file creation, and wait for the separate test approval before writing them. Match verification to requested layers: frontend-only tasks use Playwright, backend/API tasks use backend tests or bounded local curl, and full-stack tasks verify APIs first then the UI in Playwright. Do not include unrelated features or ask “shall I proceed?”; the CLI adds the approval prompt. Do not call tools, inspect the workspace, or change anything before the plan. Stop and wait for “continue” or “do it”; if the user says “edit plan”, revise only the plan and wait again. Once approved, inspect the workspace, follow the approved scope, create missing parents before files, and continue through checks. If inspection requires a material scope change, ask for approval of a revised plan. Never create an unnecessary folder when a file belongs at the project root.\n' +
  '- Keep the user informed with brief progress updates as folders, files, setup, and checks happen. Do not stop at the plan or after writing code.\n' +
  '- Batch independent file writes into one tool-call turn after their parent folders exist; avoid extra model turns between unrelated files.\n' +
  '- In /coding, always ensure the project has .env and .gitignore patterns respected: never write or create .env directly (it is blocked by security policy as protected credential material); instead provide safe code fallback defaults and create .env.example with placeholders. Preserve an existing .gitignore and add only missing .env and node_modules/ ignore entries. Never put real secrets in files.\n' +
  '- Ask before installing dependencies or creating optional unit-test files; tests are optional unless requested or needed by existing project conventions. When adding tests, put them in the project test directory outside src/ (prefer the existing convention, otherwise tests/) and keep each test file minimal and focused. If declined, skip them and continue. Ask once before running checks/server/API smoke tests; that approval covers this prompt. Destructive file actions still require approval.\n' +
  '- Install declared npm dependencies with install_project_dependencies only after project files are ready; wait for approval and report if installation is declined or fails. Then run relevant checks.\n' +
  '- Before starting services, inspect package scripts and run the relevant configured unit/API tests, lint, typecheck, and build checks. For Java/Maven projects containing pom.xml, use run_maven_tests. Start a local app with start_project_server after setup when runtime verification is needed. On macOS, port 5000 is occupied by default by AirPlay Receiver (Control Center); use alternate ports such as 5001, 8000, 8080, or 3001 for Node/Express backends to avoid EADDRINUSE collisions. For a new Node API, include a start script and start it with purpose="api"; always provide a simple health check endpoint (GET /api/health or /health) returning JSON {"status":"ok"}. Unit/API test files are optional; do not create them by default unless requested or in the approved plan. When adding backend unit tests, prefer lightweight native tests (e.g. Node built-in node:test with "test": "node --test") to keep execution fast and avoid heavy test dependencies. Use curl_local_api only for backend/API verification, against localhost/127.0.0.1/[::1] only; never use external URLs, redirects, or credentials. Use bounded GET/POST/PUT/DELETE requests for REST smoke verification. Never use curl as a frontend/UI test.\n' +
  '- If start_project_server reports that the port is already in use (EADDRINUSE) or fails to start, DO NOT retry start_project_server or repeatedly rewrite files without changing the port. Report the port conflict in the result summary as BLOCKED/SKIPPED and ask the user to free the port or specify an alternate port.\n' +
  '- Verification order: run configured unit/API tests first; run configured lint, typecheck, and build scripts when relevant. For backend/API work, start the managed API server, wait for an actual loopback HTTP response, run relevant project API tests with isolated test data and cleanup, and use the bounded curl tool only as a smoke check—not as proof of CRUD behavior. If no meaningful API tests exist, propose a small project-native test and get approval before creating it; do not add a framework automatically. For frontend-only work, run configured static/build checks, start the managed frontend, wait for HTTP readiness, then use private Playwright for a representative interaction and confirm its expected visible result; do not use curl as a UI test. For full-stack work, complete backend checks first, then start/verify the frontend and use Playwright to verify the frontend-to-backend flow and expected visible result. If one local server serves both layers, start it once and defer Playwright until the API check passes; otherwise run the backend and frontend together. Keep processes alive until checks complete and stop only Sun2Agent-owned process groups in turn cleanup. Do not start the next dependent phase after a required server/API check fails. If a check is unavailable or declined, report it as SKIPPED/NOT RUN, never PASS. Docker browser checks stay headless.\n' +
  '- For write_file, content must be a plain string; JSON file content is serialized text, not an object.\n' +
  '- If project code reads environment variables, create or update a sanitized .env.example listing them with safe placeholders/defaults; keep .env ignored and never write real secrets. Do not add .env.example when the project uses no environment variables.\n' +
  '- For local project files, use workspace tools only; do not switch to another MCP server for similarly named filesystem tools. There is no run_shell_command or bash tool in /coding: to execute scripts use run_project_check(script="build"|"test") or start_project_server(script="start"|"dev", purpose="frontend"|"api").\n' +
  '- If a tool rejects arguments, check its schema and correct the call once. Do not repeat the same invalid call or switch to an unrelated MCP server.\n' +
  '- For Playwright, keep testing fast, snappy, and essential: 1. browser_navigate to the local server URL, 2. perform one quick representative interaction (fill an input and click a button to add an item), 3. take browser_snapshot to choose a visible locator and confirm the expected rendered result. Avoid repetitive snapshot or network polling loops; once the snapshot confirms the interaction, complete the check promptly. Resolve console or failed-network errors and rerun the interaction before reporting success. Do not send a success/result summary until all requested checks have finished.\n' +
  '- For frontend tasks, use Playwright on the local URL and inspect browser_console_messages and browser_network_requests when diagnosing errors. Do not use /browser or visit remote sites.\n' +
  '- Do not claim completion until reporting actual install, unit/API test, static/build, readiness, HTTP/API, Playwright, and cleanup outcomes that apply. Distinguish a Playwright interaction smoke check from confirmation of the requested UI behavior. If a phase cannot run, say why and label it SKIPPED or NOT CONFIGURED.\n' +
  '- Finish with a concise **Result** section and a Markdown table of files, dependency status, unit/API tests, lint/typecheck/build, backend readiness/API checks, frontend readiness/Playwright, and cleanup. Use PASS, FAIL, SKIPPED, or NOT CONFIGURED; include exact test counts/errors and elapsed time when available. For APIs, add one compact endpoint table. Report only observed outcomes and never present planned work as completed. Keep progress updates brief.';

const CODING_BROWSER_PROMPT =
  '\n\nPrivate coding browser: it was started after the local app server became ready. Keep testing fast and essential: 1) browser_navigate to the local server URL (e.g. http://localhost:PORT), 2) perform one representative interaction (e.g. type in an input and click add), 3) take a final browser_snapshot to verify the rendered UI. Once confirmed, stop browser tools and conclude with the result table. Use only localhost, 127.0.0.1, or [::1], with synthetic test data. Never visit remote sites.';

const CODING_BROWSER_TOOLS = new Set([
  'browser_click', 'browser_console_messages', 'browser_find', 'browser_fill_form',
  'browser_navigate', 'browser_network_requests',
  'browser_press_key', 'browser_snapshot', 'browser_type', 'browser_wait_for'
]);

function selectCodingBrowserTools(specs, routes) {
  return specs.filter((spec) => {
    const route = routes.get(spec.function.name);
    return route?.server === 'coding-browser' && CODING_BROWSER_TOOLS.has(route.tool);
  });
}

module.exports = {
  CODING_WORKFLOW_PROMPT,
  CODING_BROWSER_PROMPT,
  selectCodingTools,
  isCodingToolAllowed,
  hasPlanHeading,
  isToolPayload,
  fallbackPlan,
  isTestFilePath,
  formatCodingPlan,
  selectCodingBrowserTools,
  progressLabel,
  missingVerification
};
