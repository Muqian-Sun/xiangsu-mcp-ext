'use strict';
// AI 组合效果: the photo is sent with a workflow (AI Graph) to the cloud, which generates the result.
// The menu item AICombine only adds an empty texture; the AI effect window builds the graph and its
// 「应用」 compiles it, uploads it and fills the texture. These mirror the window's 「新建工作流」 and
// 「应用」; nodes, prompts and preview generation are left to the official workflow tools.
const { M, editingScene, sceneObjectSet, sceneObjectPath } = require('./common.cjs');

// Event the AI graph manager reports apply failures on, instead of throwing.
const APPLY_TOAST = 'AIEffectShowToast';

function graphSummary(graph) {
  return {
    ai_graph_id: graph.uniqueId,
    nodes: [...graph.getNodes()].map((n) => ({ node_id: n.uniqueName, type: n.AINodeType, name: n.nodeName })),
  };
}

const methods = {
  aiGraphManager() {
    this.ensureCompatible('aiCombine');
    return this.mod(M.aiGraphManager).AIGraphManager.getInstance();
  },

  aiCombineNew() {
    const mgr = this.aiGraphManager();
    if (!this.mod(M.ef).ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    const graph = this.mod(M.aiGraphProject).createAIGraph();
    mgr.isGraphInit = true;
    mgr.autoSaveManager.clearDraft();
    mgr.addGraph(graph);
    return graphSummary(graph);
  },

  async aiCombineApply({ graph_id } = {}) {
    if (typeof graph_id !== 'string' || !graph_id) throw Error('INVALID_GRAPH_ID: graph_id must be a non-empty string');
    const mgr = this.aiGraphManager();
    const { sceneEditor } = editingScene(this);
    if (!mgr.getGraphById(graph_id)) {
      throw Error(`UNKNOWN_AI_GRAPH: ${graph_id}; graphs in this window: ${[...mgr.allGraphs.keys()].join(', ') || '(none)'}`);
    }
    mgr.switchGraphbyGuid(graph_id);
    const before = sceneObjectSet(sceneEditor);
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (msg) => toasts.push(String(msg));
    bus.on(APPLY_TOAST, onToast);
    try {
      await mgr.editorPanelApply();
    } finally {
      bus.off(APPLY_TOAST, onToast);
    }
    if (toasts.length) throw Error(`AI_COMBINE_APPLY_FAILED: ${toasts.join('; ')}`);
    const added = sceneEditor.getAllSceneObjectEditors().filter((o) => !before.has(o));
    if (!added.length) throw Error('AI_COMBINE_APPLY_NO_EFFECT: the editor added no scene objects (it refuses while a voice change component is in the scene; see the editor log)');
    return {
      ai_graph_id: graph_id,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      draft_id: mgr.autoSaveManager.draftId || null,
    };
  },
};

const METHODS = { ai_combine_new: 'aiCombineNew', ai_combine_apply: 'aiCombineApply' };

module.exports = { methods, METHODS, APPLY_TOAST };
