'use strict';
// The editor's "add object" menu: toolbar 美妆 / 美型 / AI 实时变脸 and the hierarchy add menu.
const fs = require('fs');
const path = require('path');
const { M, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

// Cloud AI generation / chat entries: they consume account quota or need user uploads, so they are not exposed.
const MENU_DENY = new Set(['AIDraw', 'AIVideo', 'AIImageCaption', 'Audio_AIMusic', 'AICombine', 'AIChat', 'AIObjectLens']);
const MAX_MENU_PREVIEW = 8;

const methods = {
  menuApi() {
    this.ensureCompatible('menu');
    const ui = this.mod(M.orionui);
    const EF = this.mod(M.ef);
    return {
      I18n: ui.I18n,
      emc: ui.ExtensionManager.host.getAPI(EF.Extension.MenuConfig.MenuConfigAPIKey).getEntityMenuConfig(),
      dyn: this.mod(M.dynamic).DynamicMenuConfigInfo.instance,
    };
  },

  menuEntries() {
    const { I18n, emc, dyn } = this.menuApi();
    const tr = (k) => (k ? I18n.t(k) || k : '');
    const out = [];
    const walk = (node, trail) => {
      const cfg = emc.getConfig(node.id) || node;
      const name = tr(cfg.displayKey) || tr(node.displayKey) || node.displayName || node.id;
      const kids = node.children || [];
      if (kids.length) {
        kids.forEach((c) => walk(c, [...trail, name]));
        return;
      }
      if (MENU_DENY.has(node.id)) return;
      out.push({
        menu_id: node.id,
        name,
        path: trail.join('/'),
        kind: cfg.hasPrefab ? 'package' : 'builtin',
        components: (cfg.components || []).map((c) => c.extraType || c.rttiType).filter(Boolean),
      });
    };
    const tree = dyn.updateOrderEntityMenuConfigs();
    (Array.isArray(tree) ? tree : [tree]).forEach((n) => walk(n, []));
    return out;
  },

  menuList({ query } = {}) {
    const all = this.menuEntries();
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const items = q ? all.filter((e) => `${e.path}/${e.name}/${e.menu_id}`.toLowerCase().includes(q)) : all;
    return { total: all.length, items };
  },

  menuEntry(menu_id) {
    if (typeof menu_id !== 'string' || !menu_id) throw Error('INVALID_MENU_ID: menu_id must be a non-empty string');
    if (MENU_DENY.has(menu_id)) throw Error(`MENU_ITEM_NOT_ALLOWED: ${menu_id} is a cloud AI generation entry`);
    const entry = this.menuEntries().find((e) => e.menu_id === menu_id);
    if (!entry) throw Error(`UNKNOWN_MENU_ID: ${menu_id}; call menu_list to find ids`);
    return entry;
  },

  async menuAdd({ menu_id }) {
    const entry = this.menuEntry(menu_id);
    const { sceneEditor, project } = editingScene(this);
    const { emc, dyn } = this.menuApi();
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    if (entry.kind === 'package') {
      if (!dyn.downloadTaskMap.has(menu_id)) throw Error(`PACKAGE_NOT_REGISTERED: ${menu_id} has no download task in this editor session`);
      await dyn.handleDownloadPromise(menu_id);
    } else {
      const config = emc.getConfig(menu_id);
      if (!config) throw Error(`UNKNOWN_MENU_ID: ${menu_id}`);
      await this.mod(M.sceneOps).createEntity(sceneEditor, config, entry.name, () => {});
    }
    const added = addedObjectEditors(before, sceneEditor);
    if (!added.length) throw Error(`MENU_ADD_NO_EFFECT: ${menu_id} did not add scene objects (see editor log)`);
    const packageFolders = packageRootsAdded(project, beforePaths);
    recordImport(project, added, packageFolders);
    return {
      menu_id,
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      package_folders: packageFolders,
    };
  },

  // Description and illustration the editor shows when hovering the menu item. Images are either CDN
  // URLs or files bundled with the editor under hoverTips/object/<menu_id>/.
  menuPreview({ menu_ids }) {
    if (!Array.isArray(menu_ids) || !menu_ids.length || menu_ids.length > MAX_MENU_PREVIEW) {
      throw Error(`INVALID_MENU_IDS: pass 1-${MAX_MENU_PREVIEW} menu ids`);
    }
    const { I18n } = this.menuApi();
    const H = this.mod(M.hover).HoverTipsMap;
    return menu_ids.map((id) => {
      const entry = this.menuEntry(id);
      const tip = H.getObjectTipsBy(id) || {};
      const desc = tip.DescriptionTranslation || (tip.Description ? I18n.t(tip.Description) || tip.Description : '');
      const img = (tip.Images || []).find((s) => typeof s === 'string' && s) || null;
      let image_url = null;
      let image_file = null;
      if (img && /^https?:\/\//.test(img)) image_url = img;
      else if (img && H._basePath) {
        const file = path.join(H._basePath, 'object', id, img);
        if (fs.existsSync(file)) image_file = file;
      }
      return { menu_id: id, name: entry.name, description: tip.Enable === false ? '' : desc, image_url, image_file };
    });
  },
};

const METHODS = { menu_list: 'menuList', menu_add: 'menuAdd', menu_preview: 'menuPreview' };

module.exports = { methods, METHODS, MENU_DENY, MAX_MENU_PREVIEW };
