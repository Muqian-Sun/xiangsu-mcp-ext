import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

let seq = 0;
function graph() {
  seq += 1;
  const nodes = [
    { uniqueName: `Input-in${seq}`, AINodeType: 'Input', nodeName: '输入图' },
    { uniqueName: `Combination-out${seq}`, AINodeType: 'Combination', nodeName: '效果组合' },
  ];
  return { uniqueId: `graph-${seq}`, getNodes: () => new Set(nodes) };
}

// A fake editor: the AI graph manager, its toast bus and a scene the 「应用」 step adds objects to.
// `apply` decides what editorPanelApply does: 'add' (succeeds), 'toast' (rejects with a toast) or 'none'.
function setup({ active = true, apply = 'add' } = {}) {
  const calls = { created: 0, cleared: 0, switched: [], appliedOn: [] };
  const handlers = new Map();
  const bus = {
    on: (ev, fn) => handlers.set(ev, [...(handlers.get(ev) || []), fn]),
    off: (ev, fn) => handlers.set(ev, (handlers.get(ev) || []).filter((f) => f !== fn)),
    emit: (ev, ...a) => (handlers.get(ev) || []).forEach((f) => f(...a)),
  };
  const sceneObjects = [{ name: '已有', parent: null }];
  const mgr = {
    isGraphInit: false,
    allGraphs: new Map(),
    curGraph: null,
    autoSaveManager: { draftId: '', clearDraft: () => calls.cleared++ },
    addGraph(g) {
      this.allGraphs.set(g.uniqueId, g);
    },
    getGraphById(id) {
      return this.allGraphs.get(id);
    },
    switchGraphbyGuid(id) {
      calls.switched.push(id);
      this.curGraph = this.allGraphs.get(id);
    },
    async editorPanelApply() {
      calls.appliedOn.push(this.curGraph && this.curGraph.uniqueId);
      if (apply === 'toast') return bus.emit('AIEffectShowToast', '请先连接效果组合器');
      if (apply === 'add') {
        const fg = { name: '2D 前景', parent: null };
        const cam = { name: '2D 摄像机', parent: fg };
        sceneObjects.push(fg, cam, { name: 'AI 组合效果', parent: cam });
      }
    },
  };
  class AIGraphManager {
    static getInstance() {
      return mgr;
    }
  }
  for (const k of ['addGraph', 'getGraphById', 'switchGraphbyGuid', 'editorPanelApply']) AIGraphManager.prototype[k] = mgr[k];
  const modules = {
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => active, getCurrentActiveProject: () => ({}) }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...sceneObjects] } }) } },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
    [M.aiGraphManager]: { AIGraphManager },
    // Like the editor's, the new graph becomes the current one.
    [M.aiGraphProject]: {
      createAIGraph: () => {
        calls.created++;
        mgr.curGraph = graph();
        return mgr.curGraph;
      },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, mgr, modules, handlers };
}

test('ai_combine_new does what 「新建工作流」 does and returns the ids the official workflow tools take', () => {
  const { lib, calls, mgr } = setup();
  const out = lib.aiCombineNew();
  assert.equal(calls.created, 1);
  assert.equal(mgr.isGraphInit, true);
  assert.equal(calls.cleared, 1);
  assert.equal(mgr.getGraphById(out.ai_graph_id).uniqueId, out.ai_graph_id);
  assert.deepEqual(out, {
    ai_graph_id: out.ai_graph_id,
    nodes: [
      { node_id: out.ai_graph_id.replace('graph-', 'Input-in'), type: 'Input', name: '输入图' },
      { node_id: out.ai_graph_id.replace('graph-', 'Combination-out'), type: 'Combination', name: '效果组合' },
    ],
  });
});

test('ai_combine_new refuses without an active project and before creating a graph', () => {
  const { lib, calls } = setup({ active: false });
  assert.throws(() => lib.aiCombineNew(), /NO_ACTIVE_PROJECT/);
  assert.equal(calls.created, 0);
});

test('ai_combine_apply applies the requested graph and reports every object it added', async () => {
  const { lib, calls, mgr, handlers } = setup();
  const a = lib.aiCombineNew().ai_graph_id;
  const b = lib.aiCombineNew().ai_graph_id;
  assert.equal(mgr.curGraph.uniqueId, b);
  const out = await lib.aiCombineApply({ graph_id: a });
  assert.deepEqual(calls.appliedOn, [a]);
  assert.deepEqual(out, {
    ai_graph_id: a,
    added_objects: [
      { name: '2D 前景', object_path: '2D 前景' },
      { name: '2D 摄像机', object_path: '2D 前景/2D 摄像机' },
      { name: 'AI 组合效果', object_path: '2D 前景/2D 摄像机/AI 组合效果' },
    ],
    draft_id: null,
  });
  assert.deepEqual(handlers.get('AIEffectShowToast'), []);
});

test('ai_combine_apply reports the draft id when the workflow was saved as a cloud draft', async () => {
  const { lib, mgr } = setup();
  const id = lib.aiCombineNew().ai_graph_id;
  mgr.autoSaveManager.draftId = '89938740';
  assert.equal((await lib.aiCombineApply({ graph_id: id })).draft_id, '89938740');
});

test('ai_combine_apply turns the editor toast into an error and stops listening', async () => {
  const { lib, handlers } = setup({ apply: 'toast' });
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: id }), /AI_COMBINE_APPLY_FAILED: 请先连接效果组合器/);
  assert.deepEqual(handlers.get('AIEffectShowToast'), []);
});

test('ai_combine_apply fails when the editor added nothing', async () => {
  const { lib } = setup({ apply: 'none' });
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: id }), /AI_COMBINE_APPLY_NO_EFFECT/);
});

test('ai_combine_apply refuses unknown or missing graph ids before applying', async () => {
  const { lib, calls } = setup();
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: 'nope' }), new RegExp(`UNKNOWN_AI_GRAPH: nope; graphs in this window: ${id}`));
  await assert.rejects(lib.aiCombineApply({}), /INVALID_GRAPH_ID/);
  assert.deepEqual(calls.appliedOn, []);
  assert.deepEqual(calls.switched, []);
});

test('ai_combine calls refuse to run when the AI graph internals are missing', async () => {
  const { lib, modules, calls } = setup();
  delete modules[M.aiGraphManager].AIGraphManager.prototype.editorPanelApply;
  assert.throws(() => lib.aiCombineNew(), /INCOMPATIBLE_EDITOR: missing .*editorPanelApply/);
  await assert.rejects(lib.aiCombineApply({ graph_id: 'x' }), /INCOMPATIBLE_EDITOR/);
  assert.equal(calls.created, 0);
  assert.equal(lib.selfCheck().features.aiCombine, false);
});
