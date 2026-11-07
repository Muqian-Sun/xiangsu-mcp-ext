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

// Objects without render groups, as read from a scene file.
export function formatObjects(objects) {
  const lines = [];
  treeLines(objects, 0, lines);
  return lines.join('\n');
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

// preset "key": the parameters that usually decide how an effect looks. Picked, not measured, from
// the effects made so far (makeup, face warps, stickers, text); anything else is still reachable with
// fields or component_types.
const KEY_FIELDS = ['position', 'scale', 'rotation', 'orientation', 'euler', 'visible', 'enabled', 'intensity', 'strength', 'opacity', 'alpha', 'amount', 'weight', 'color'];
// Matched whole: a Text's content and a 2D object's size; as fragments they would match far more.
const KEY_NAMES = ['str', 'sizeDelta'];
// A bound resource or scene object, after resolveRefs (online) or as the scene file reader gives it.
const isBinding = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && v.guid !== 'null' && ['resource', 'builtin', 'object', 'path', 'guid'].some((k) => k in v) && Object.keys(v).length <= 3;
const hasBinding = (v) => (Array.isArray(v) ? v.some(hasBinding) : isBinding(v));

// Keeps the components (by type) and properties (by name fragment, or preset "key") asked for, with
// values unwrapped. Script components (`script: true`, known only from a scene file) keep all their
// properties under the preset: they are the script's exposed parameters.
export function pickInspect(res, { component_types, fields, preset } = {}) {
  const filtered = !!(fields || preset);
  const keep = (c, k, v) => (fields && matches(k, fields)) || (preset === 'key' && (c.script || KEY_NAMES.includes(k) || matches(k, KEY_FIELDS) || hasBinding(v)));
  const components = (res.components || [])
    .filter((c) => !component_types || component_types.includes(c.type))
    .map((c) => {
      const props = Object.entries(c.properties || {})
        .map(([k, v]) => [k, unwrap(v)])
        .filter(([k, v]) => !filtered || keep(c, k, v));
      return { type: c.type, guid: c.guid, ...(c.script ? { script: true } : {}), properties: Object.fromEntries(props) };
    })
    .filter((c) => !filtered || Object.keys(c.properties).length);
  return { guid: res.guid, name: res.name, component_types: res.componentTypes || components.map((c) => c.type), components };
}

const isHandle = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.guid === 'string';

// The official inspect gives bound resources and objects as bare handles ({ guid: "r3" }); each is
// looked up once with `lookup` (the official inspect) and replaced by what it names.
export async function resolveRefs(value, lookup, { root, cache = new Map() } = {}) {
  const walk = async (v) => {
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (isHandle(v)) {
      if (v.guid === 'null') return null;
      if (!cache.has(v.guid)) cache.set(v.guid, lookup(v.guid).catch((e) => ({ error: String(e.message ?? e) })));
      const r = await cache.get(v.guid);
      if (r.error) return { guid: v.guid, error: r.error };
      if (r.kind === 'resource') {
        const rel = root && r.filePath && r.filePath.startsWith(root + '/') ? r.filePath.slice(root.length + 1) : r.filePath;
        return { resource: r.name, type: r.type, file: rel?.startsWith('Assets/') ? rel.slice('Assets/'.length) : rel };
      }
      return { object: v.guid, name: r.name };
    }
    if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await walk(x)])));
    return v;
  };
  return walk(value);
}
