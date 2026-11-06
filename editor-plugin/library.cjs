'use strict';
// Entry the runtime (re)loads: assembles the Library class from the feature modules and the RPC
// method table. Feature modules are dropped from the require cache on every load so edits take effect.
const fs = require('fs');
const path = require('path');

const FEATURE_DIR = path.join(__dirname, 'features');
const FEATURE_FILES = fs
  .readdirSync(FEATURE_DIR)
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(FEATURE_DIR, f));
for (const f of FEATURE_FILES) delete require.cache[f];

const common = require('./features/common.cjs');
const assets = require('./features/assets.cjs');
const menu = require('./features/menu.cjs');
const facewarp = require('./features/facewarp.cjs');
const project = require('./features/project.cjs');
const cleanup = require('./features/cleanup.cjs');
const works = require('./features/works.cjs');
const dev = require('./features/dev.cjs');

const { Library } = assets;
const features = [menu, facewarp, project, cleanup, works, dev];
for (const f of features) Object.assign(Library.prototype, f.methods);

// RPC method name -> Library method; the runtime dispatches through this table.
const METHODS = Object.assign({}, assets.METHODS, ...features.map((f) => f.METHODS));

module.exports = {
  Library,
  METHODS,
  FEATURE_FILES,
  M: common.M,
  slim: assets.slim,
  REQUIRED: assets.REQUIRED,
  MAX_PREVIEW: assets.MAX_PREVIEW,
  MENU_DENY: menu.MENU_DENY,
  WORK_SORTS: works.SORT,
  CONFIG_PATH: dev.CONFIG_PATH,
};
