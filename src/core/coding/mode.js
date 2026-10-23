let enabled = false;
let pendingPlan = null;
let activePlan = null;

function toggle() {
  enabled = !enabled;
  if (!enabled) {
    pendingPlan = null;
    activePlan = null;
  }
  return enabled;
}

function setPendingPlan(plan) { pendingPlan = plan; }
function getPendingPlan() { return pendingPlan; }
function clearPendingPlan() { pendingPlan = null; }

function setActivePlan(plan) {
  activePlan = plan ? { ...plan, status: 'in_progress' } : null;
}
function getActivePlan() { return activePlan; }
function clearActivePlan() { activePlan = null; }

function hasInterruptedPlan() {
  return Boolean(activePlan && activePlan.status === 'interrupted');
}

function markInterrupted() {
  if (activePlan) activePlan.status = 'interrupted';
}

function markCompleted() {
  if (activePlan) activePlan.status = 'completed';
}

function clearAll() {
  pendingPlan = null;
  activePlan = null;
}

function isContinuationPhrase(text) {
  return /^(?:continue|resume|retry|try again|proceed|pick up|keep going|go ahead|do it)[.!\s]*$/i.test(text);
}

function decidePendingPlan(input) {
  const text = String(input || '').trim();

  // 1. If there's a newly generated plan waiting for initial user approval:
  if (pendingPlan) {
    if (/^(?:continue|do(?: it)?|proceed|approve|approved|yes|go ahead)[.!\s]*$/i.test(text)) {
      const plan = pendingPlan;
      clearPendingPlan();
      activePlan = { task: plan.task, plan: plan.plan, status: 'in_progress' };
      return { action: 'approve', plan: activePlan };
    }
    const edit = text.match(/^(?:edit|revise|change|update)\s+(?:the\s+)?plan\b[:\s-]*(.*)$/is);
    if (edit) return { action: 'edit', plan: pendingPlan, instruction: edit[1].trim() };
    if (/^(?:cancel|discard|stop)[.!\s]*$/i.test(text)) {
      clearAll();
      return { action: 'cancel' };
    }
    return { action: 'wait' };
  }

  // 2. If an approved plan was interrupted (error, timeout, or Esc), and user wants to continue/retry:
  if (activePlan && activePlan.status === 'interrupted') {
    if (/^(?:cancel|discard|stop)[.!\s]*$/i.test(text)) {
      clearAll();
      return { action: 'cancel' };
    }
    const edit = text.match(/^(?:edit|revise|change|update)\s+(?:the\s+)?plan\b[:\s-]*(.*)$/is);
    if (edit) {
      return { action: 'edit', plan: activePlan, instruction: edit[1].trim() };
    }
    if (isContinuationPhrase(text)) {
      activePlan.status = 'in_progress';
      return { action: 'resume', plan: activePlan };
    }
    // If the user provided guidance for continuing the interrupted step:
    if (/^(?:retry|continue|resume|fix|try|pick up)\b/i.test(text)) {
      activePlan.status = 'in_progress';
      return { action: 'resume', plan: activePlan, userGuidance: text };
    }
    // If the user entered a new request/edit, clear the old activePlan
    // so a fresh plan can be created for the new request.
    clearActivePlan();
  }

  return null;
}

module.exports = {
  toggle,
  isEnabled: () => enabled,
  setPendingPlan,
  getPendingPlan,
  clearPendingPlan,
  setActivePlan,
  getActivePlan,
  clearActivePlan,
  hasInterruptedPlan,
  markInterrupted,
  markCompleted,
  clearAll,
  decidePendingPlan
};
