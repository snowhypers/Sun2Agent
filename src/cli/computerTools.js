// Keep the model's computer-tool catalog small without removing execution-time
// routing, guardrails or HITL. The model can load other computer schemas with
// computer__sun2agent_search_tools when the starting set is insufficient.
const STARTER_TOOLS = new Set([
  'activate_app', 'activate_window', 'click_element', 'find_element',
  'get_frontmost_app', 'get_ui_tree', 'key', 'list_windows',
  'open_application', 'screenshot', 'sun2agent_search_tools', 'select_menu_item',
  'snapshot', 'type', 'sun2agent_wait_for_window'
]);

function selectToolSpecs(specs, routes, discovered = new Set()) {
  return specs.filter((spec) => {
    const name = spec.function?.name;
    const route = routes.get(name);
    return route?.server !== 'computer' || STARTER_TOOLS.has(route.tool) || discovered.has(route.tool);
  });
}

module.exports = { STARTER_TOOLS, selectToolSpecs };
