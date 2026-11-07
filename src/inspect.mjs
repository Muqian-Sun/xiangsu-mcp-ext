// Compact views over the official get_scene / inspect results, so an agent can read a scene's structure
// and the parameters it cares about without post-processing them in a script.

// Arrays longer than this (brush data, keyframes, vertex lists) are summarised. Picked, not measured:
// long enough for real parameter lists, short enough that one component does not flood the output.
const MAX_ARRAY = 20;

// The official tools wrap typed values as { type, data }; the value an agent reasons about is `data`.
export function unwrap(v) {
  if (Array.isArray(v)) {
    const items = v.map(unwrap);
    return items.length > MAX_ARRAY ? { length: items.length, first: items.slice(0, 5) } : items;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.includes('data') && keys.every((k) => k === 'type' || k === 'data')) return unwrap(v.data);
    return Object.fromEntries(keys.map((k) => [k, unwrap(v[k])]));
  }
  return v;
}

function treeLines(objects, indent, lines) {
  for (const o of objects || []) {
    const flags = o.visible === false ? ' (隐藏)' : '';
    const types = (o.componentTypes || []).join(', ');
    lines.push(`${'  '.repeat(indent)}${o.guid} ${o.name}${flags}${types ? `  [${types}]` : ''}`);
    const children = o.children || [];
    treeLines(children, indent + 1, lines);
    const hidden = (o.childCount ?? children.length) - children.length;
    if (hidden > 0) lines.push(`${'  '.repeat(indent + 1)}… 还有 ${hidden} 个子对象未展开（加大 depth 或用 subtree 查看）`);
  }
}

// One line per render group and scene object: guid, name, hidden flag, component types.
export function formatTree(scene) {
  const lines = [];
  for (const g of scene.renderGroups || []) {
    lines.push(`[${g.name}] ${g.guid || ''}${g.type ? ` ${g.type}` : ''}${g.enabled === false ? ' (停用)' : ''}`.trimEnd());
    treeLines(g.sceneObjects, 1, lines);
  }
  if (!scene.renderGroups && scene.guid) treeLines([scene], 0, lines);
  return lines.join('\n');
}

const matches = (name, patterns) => patterns.some((p) => name.toLowerCase().includes(p.toLowerCase()));

// Keeps the components (by type) and properties (by name fragment) asked for, with values unwrapped.
export function pickInspect(res, { component_types, fields } = {}) {
  const components = (res.components || [])
    .filter((c) => !component_types || component_types.includes(c.type))
    .map((c) => {
      const props = Object.entries(c.properties || {}).filter(([k]) => !fields || matches(k, fields));
      return { type: c.type, guid: c.guid, properties: Object.fromEntries(props.map(([k, v]) => [k, unwrap(v)])) };
    })
    .filter((c) => !fields || Object.keys(c.properties).length);
  return { guid: res.guid, name: res.name, component_types: res.componentTypes || components.map((c) => c.type), components };
}
