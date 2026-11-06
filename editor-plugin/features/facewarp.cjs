'use strict';
// 塑型画笔 (FaceWarpX) components store brush data per item next to its intensity; the official MCP can
// read the intensity but cannot write it back without the brush data, so these go through the editor.
const { editingScene, sceneObjectPath, resolveByPath } = require('./common.cjs');

const WARP_EDITORS = { FaceWarpXComponentEditor: 'Human', CatFaceWarpXComponentEditor: 'Cat', DogFaceWarpXComponentEditor: 'Dog' };

function describeWarp({ comp, path: p, face }) {
  return {
    object_path: p,
    face,
    enabled: !!comp.enabled,
    items: (comp.items || []).map((it, index) => ({ index, label: it.labelName || null, intensity: it.intensity })),
  };
}

const methods = {
  faceWarps() {
    const { sceneEditor } = editingScene(this);
    return sceneEditor
      .getAllComponentEditors()
      .filter((c) => Object.prototype.hasOwnProperty.call(WARP_EDITORS, c.constructor.name))
      .map((c) => ({ comp: c, path: sceneObjectPath(c.sceneObject), face: WARP_EDITORS[c.constructor.name] }));
  },

  faceWarpList() {
    return { face_warps: this.faceWarps().map(describeWarp) };
  },

  async faceWarpSetIntensity({ object_path, intensity, item_index }) {
    if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 100) throw Error('INVALID_INTENSITY: intensity must be a number in [0, 100]');
    const target = resolveByPath(this.faceWarps(), object_path, 'FACE_WARP');
    const { comp } = target;
    const items = comp.items || [];
    if (!items.length) throw Error(`NO_WARP_ITEMS: ${target.path} has no brush items`);
    if (item_index !== undefined && (!Number.isInteger(item_index) || item_index < 0 || item_index >= items.length)) {
      throw Error(`INVALID_ITEM_INDEX: ${item_index}; ${target.path} has ${items.length} item(s)`);
    }
    const before = describeWarp(target);
    const next = items.map((it, i) => (item_index === undefined || i === item_index ? it.withIntensity(intensity) : it));
    const { EF } = editingScene(this);
    EF.UndoSystem.instance.start(`set face warp intensity: ${target.path}`);
    let res;
    try {
      res = comp.setProperty('items', next);
    } finally {
      EF.UndoSystem.instance.end();
    }
    if (res instanceof Error) throw Error(`SET_PROPERTY_FAILED: ${res.message}`);
    const after = describeWarp(target);
    const changed = after.items.filter((it) => item_index === undefined || it.index === item_index);
    if (changed.some((it) => it.intensity !== intensity)) throw Error(`WRITE_NOT_APPLIED: ${JSON.stringify(after.items)}`);
    return { object_path: target.path, before: before.items, after: after.items };
  },
};

const METHODS = { face_warp_list: 'faceWarpList', face_warp_set_intensity: 'faceWarpSetIntensity' };

module.exports = { methods, METHODS, WARP_EDITORS };
