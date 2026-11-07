// Reads a project's Assets/main.scene without an editor window (a downloaded work, a closed project),
// into the same shapes the official get_scene / inspect return, so scene_tree and inspect_many format
// both the same way. Objects are addressed as #<n>, their order in the scene file.
// main.scene holds the runtime components; main.scene.extra holds the editor's side of each one
// (matched by objGuid): the component name the editor shows (FaceMask, GanComponent) and the
// parameters its inspector edits (a makeup's texture and intensity).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Resources shipped with the editor rather than the project: their ids start with these (not always
// hex, e.g. 00000000-0000-0000-0000-0000000000l3), and share:// is the editor's camera input.
const BUILTIN = /^(custom:\/\/)?(00000000|55000000)-|^share:\/\//;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.extra')) out.push(p);
  }
  return out;
}

// Every asset's .extra lists the resources it holds; scene references point at them by uuid
// (`guid.a`, or `uuid` for generated ones such as the head-fitting mesh).
export function resourceIndex(assetsDir, skip = new Set()) {
  const index = new Map();
  const unreadable = [];
  for (const file of walk(assetsDir)) {
    if (skip.has(file)) continue;
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      unreadable.push(`${path.relative(assetsDir, file)}: ${e.message}`);
      continue;
    }
    const asset = path.relative(assetsDir, file).slice(0, -'.extra'.length);
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      const info = { resource: e.name, type: e.rttiType || e.extraType, file: asset };
      for (const id of [e.guid?.a, e.uuid]) if (typeof id === 'string' && id) index.set(id.toLowerCase(), info);
    }
  }
  return { index, unreadable };
}

const lid = (ref) => Number(ref.localId);
const guidKey = (g) => g && g.a !== undefined && `Guid(${g.a}, ${g.b})`;
const GUID_STRING = /^Guid\(\d+, \d+\)$/;
// Bookkeeping fields of a main.scene.extra entry, not component parameters.
const EDITOR_META = ['guid', 'objGuid', 'extraType', 'rttiType', 'name', 'version', 'editable', '_lazyUpgrateVersion', 'extendedInfo'];
// The editor entry of a project script; its rttiType is the script's name.
const USER_SCRIPT = 'UserComponentEditor';
const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'localId' in v && Object.keys(v).every((k) => k === 'localId' || k === 'path');

function parseDocs(file) {
  const byId = new Map();
  // The file declares YAML 1.1, whose schema reads the keys y and n as booleans ({x, y, z} vectors);
  // the core schema keeps them as names. Guids are 64-bit, hence BigInt.
  for (const doc of YAML.parseAllDocuments(fs.readFileSync(file, 'utf8'), { intAsBigInt: true, schema: 'core' })) {
    if (doc.errors.length) throw Error(`SCENE_PARSE_FAILED: ${file}: ${doc.errors[0].message}`);
    const id = Number(doc.contents?.anchor);
    if (!Number.isInteger(id) || byId.has(id)) throw Error(`SCENE_PARSE_FAILED: ${file}: document without a unique anchor (${doc.contents?.anchor})`);
    byId.set(id, { tag: String(doc.contents.tag || '').replace(/^!/, ''), value: doc.toJS() });
  }
  return byId;
}

export function loadScene(projectDir) {
  const assets = path.join(projectDir, 'Assets');
  const file = path.join(assets, 'main.scene');
  if (!fs.existsSync(file)) throw Error(`NO_MAIN_SCENE: ${file}`);
  const byId = parseDocs(file);
  const scene = byId.get(1);
  if (scene?.tag !== 'Scene' || !Array.isArray(scene.value.entities)) throw Error(`SCENE_PARSE_FAILED: ${file}: document &1 is not the Scene`);
  const editorFile = `${file}.extra`;
  const { index, unreadable } = resourceIndex(assets, new Set([editorFile]));
  const editor = new Map();
  if (fs.existsSync(editorFile)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(editorFile, 'utf8'))) if (e.objGuid) editor.set(e.objGuid, e);
    } catch (e) {
      unreadable.push(`main.scene.extra: ${e.message}`);
    }
  }
  const entities = scene.value.entities.map((e, i) => ({ id: `#${i + 1}`, raw: e }));
  const byTransform = new Map();
  for (const e of entities) {
    const ref = (e.raw.components || []).find((c) => isRef(c) && /Transform$/.test(byId.get(lid(c))?.tag || ''));
    e.transform = ref ? byId.get(lid(ref)).value : null;
    if (ref) byTransform.set(lid(ref), e);
  }

  const rawOf = (c) => (isRef(c) ? byId.get(lid(c))?.value || {} : c);
  const editorOf = (c) => editor.get(guidKey(rawOf(c).guid));
  // Editor parameters point at objects by their Guid(a, b) string: an entity or one of its components.
  const owners = new Map();
  for (const e of entities) {
    const who = { object: e.id, name: e.raw.name };
    owners.set(guidKey(e.raw.guid), who);
    for (const c of e.raw.components || []) owners.set(guidKey(rawOf(c).guid), who);
  }

  const resource = (p) => {
    if (typeof p !== 'string') return p;
    const id = (UUID.exec(p) || [])[0];
    if (id && index.has(id.toLowerCase())) return index.get(id.toLowerCase());
    if (BUILTIN.test(p)) return { builtin: p };
    return { path: p };
  };
  const value = (v, seen) => {
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
    // Scene floats are float32 written out as doubles (0.300000011920929); 7 significant digits is
    // what a float32 holds.
    if (typeof v === 'number' && !Number.isInteger(v)) return Number(v.toPrecision(7));
    // Editor parameters name resources by bare uuid and objects by Guid(a, b).
    if (typeof v === 'string' && GUID_STRING.test(v)) return owners.get(v) || v;
    if (typeof v === 'string' && (index.has(v.toLowerCase()) || BUILTIN.test(v))) return resource(v);
    if (Array.isArray(v)) return v.map((x) => value(x, seen));
    if (!v || typeof v !== 'object') return v;
    if (isRef(v)) {
      if ('path' in v) return v.path === undefined || v.path === null ? null : resource(v.path);
      const entity = byTransform.get(lid(v));
      if (entity) return { object: entity.id, name: entity.raw.name };
      const doc = byId.get(lid(v));
      if (!doc || seen.has(lid(v))) return { localId: lid(v) };
      return { [doc.tag]: value(doc.value, new Set([...seen, lid(v)])) };
    }
    const keys = Object.keys(v).filter((k) => k !== '__class' && k !== 'guid' && !(k === 'name' && v.name === ''));
    if (v.__class && keys.length === 1 && keys[0] === 'value') return value(v.value, seen);
    return Object.fromEntries(keys.map((k) => [k, value(v[k], seen)]));
  };
  // A project script (DadNameReveal.ts) is a DynamicComponent whose className is the script asset's uuid.
  const scriptAsset = (c) => c.__class === 'DynamicComponent' && typeof c.className === 'string' && UUID.test(c.className);
  const isScript = (c) => !isRef(c) && (c.__class === 'JSScriptComponent' || scriptAsset(c) || editorOf(c)?.extraType === USER_SCRIPT);
  const typeOf = (c) => {
    const ed = editorOf(c);
    if (ed?.extraType) return ed.extraType === USER_SCRIPT ? ed.rttiType || ed.name : ed.extraType;
    if (isRef(c)) return byId.get(lid(c))?.tag || 'Unknown';
    if (scriptAsset(c)) return index.get(c.className.toLowerCase())?.resource || c.className;
    if (c.__class === 'DynamicComponent' && c.className) return c.className;
    if (c.__class === 'JSScriptComponent' && c.path) return `JSScriptComponent(${c.path})`;
    return c.__class || 'Unknown';
  };
  // Script parameters sit under `properties` (JSScriptComponent) or serializedProperty.properties
  // (built-in JS components such as FaceBinding, Text); inspect shows them as the component's own.
  // Editor parameters come last: where both sides have one, the editor's is what the inspector shows.
  const props = (c) => {
    const raw = rawOf(c);
    const { serializedProperty, properties, ...rest } = raw;
    const merged = { ...rest, ...serializedProperty?.properties };
    if (raw.__class === 'JSScriptComponent') Object.assign(merged, properties);
    else if (properties !== undefined) merged.properties = properties;
    const ed = editorOf(c);
    if (ed) for (const [k, v] of Object.entries(ed)) if (!EDITOR_META.includes(k)) merged[k] = v;
    const { name, __class, className, parent, children, ...kept } = merged;
    return value(kept, new Set());
  };

  const children = (e) => (e.transform?.children || []).map((r) => byTransform.get(lid(r))).filter(Boolean);
  const node = (e) => ({
    guid: e.id,
    name: e.raw.name,
    visible: e.raw.selfvisible !== false,
    componentTypes: (e.raw.components || []).map(typeOf),
    childCount: children(e).length,
    entity: e,
  });
  const roots = entities.filter((e) => !e.transform?.parent || !byTransform.has(lid(e.transform.parent)));

  return {
    unreadable,
    // get_scene's object tree, `depth` levels deep; `subtree` is an #id or a name.
    tree({ subtree, depth }) {
      const build = (e, level) => ({ ...node(e), children: level < depth ? children(e).map((c) => build(c, level + 1)) : [] });
      const start = subtree ? entities.filter((e) => e.id === subtree || e.raw.name === subtree) : roots;
      if (subtree && start.length !== 1) throw Error(`SUBTREE_NOT_FOUND: ${subtree} matches ${start.length} objects in main.scene`);
      return start.map((e) => build(e, 1));
    },
    // The official inspect's shape for one object.
    inspect(id) {
      const e = entities.find((x) => x.id === id);
      if (!e) throw Error(`OBJECT_NOT_FOUND: ${id}; use the #ids scene_tree prints for project_dir`);
      const comps = e.raw.components || [];
      return {
        guid: e.id,
        name: e.raw.name,
        componentTypes: comps.map(typeOf),
        components: comps.map((c, i) => ({ type: typeOf(c), guid: `${e.id}.${i + 1}`, ...(isScript(c) ? { script: true } : {}), properties: props(c) })),
      };
    },
  };
}
