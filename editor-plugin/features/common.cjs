'use strict';
// Shared helpers for editor features: module ids, editor state lookups and scene object paths.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const M = {
  nav: '@orion/Business/AssetsLibrary/Core/Control/AssetsLibraryNav/util',
  navConst: '@orion/Business/AssetsLibrary/Core/Control/AssetsLibraryNav/const',
  category: '@orion/Business/AssetsLibrary/Core/Api/getAssetCategory',
  list: '@orion/Business/AssetsLibrary/Core/Api/getAssetList',
  search: '@orion/Business/AssetsLibrary/Core/Api/search',
  util: '@orion/Business/AssetsLibrary/Core/Control/util',
  aiCategory: '@orion/Business/AssetsLibrary/Core/Api/getAIAssetCategory',
  aiList: '@orion/Business/AssetsLibrary/Core/Api/getAIAssetList',
  aiConst: '@orion/Business/AssetsLibrary/Core/Control/AssetsList/AIAssets/AssetsList/const',
  publish: '@orion/Business/AssetsLibrary/Core/Api/publishAsset',
  resourceTypes: '@orion/Business/AssetsLibrary/Core/Control/AssetImportManager/const',
  importTypes: '@orion/Business/AssetsLibrary/View/Components/AssetImportPanel/const',
  assetsLibrary: '@orion/Business/AssetsLibrary/Core/Control/AssetsLibrary',
  collect: '@orion/Business/AssetsLibrary/Core/Api/collect',
  secondPanel: '@orion/Business/AssetsLibrary/Core/Api/getAssetSecondPanel',
  aiEffectApi: '@orion/Business/API/ai_effect_api',
  ef: '@orion/orion-sdk/EditorFramework',
  scene: '@orion/Business/Common/Scene',
  orionui: '@orion/orion-sdk/orionui',
  dynamic: '@orion/Business/BusinessCommon/MenuConfig/DynamicMenuConfig/DynamicMenuConfig',
  sceneOps: '@orion/Business/Agent/SceneOps/SceneOpsService',
  hover: '@orion/Business/UI/ORHoverTip/HoverTipsMap',
  toolbar: '@orion/Business/EditWindow/ToolBar',
  ipc: '@orion/Business/MultipleProjects/ProcessCommunication/IPCCommands',
  sender: '@orion/Business/MultipleProjects/ProcessCommunication/EditProcess/EditSender',
  worksPanel: '@orion/Business/HomeWindow/TemplatesPanel/Request/templatesPanel',
  worksCategory: '@orion/Business/HomeWindow/TemplatesPanel/Request/templatesCategory',
  worksUtil: '@orion/Business/HomeWindow/TemplatesPanel/Model/util',
  worksDownload: '@orion/Business/HomeWindow/TemplatesPanel/Model/DownloadTemplateModel',
  iconPreview: '@orion/Business/IconCreationNew/controller/IconPreviewManager',
  iconWindow: '@orion/Business/IconCreationNew/IconCreationWindow',
  iconUpload: '@orion/Business/IconCreationNew/UI/BottomPanel/DYEHIconUploadHelper',
  submission: '@orion/Business/Submission/SubmissionExtension/EffectSubmissionExtension',
  perfTest: '@orion/Business/PerfTest/PerfTestExtension',
  events: '@orion/Business/Event/BusinessEventManager',
  login: '@orion/Business/Login/LoginContribution',
  remoteAssets: '@orion/Business/RemoteAsset/RemoteAssetManager',
  mobilePreview: '@orion/Business/EditWindow/ToolBar/MobilePreview/backendHelper',
  urls: '@orion/Business/BusinessCommon/UrlConst',
  bizUtils: '@orion/Business/BusinessCommon/Utils',
  activityTypes: '@orion/Business/HomeWindow/ActivitiesCenter/Common/types',
  inspirationConst: '@orion/Business/InspirationDetail/View/const',
  inspirationBridge: '@orion/Business/Agent/AgentInspirationBridge',
  musicCategory: '@orion/Business/EditWindow/Inspector/MusicLibrary/Model/MusicCategoryModel',
  musicList: '@orion/Business/EditWindow/Inspector/MusicLibrary/Model/MusicListModel',
  musicSquare: '@orion/Business/EditWindow/Inspector/MusicLibrary/Component/MusicListComponent/MusicSquareManager',
  preview: '@orion/Business/Preview/PreviewManager',
  backgroundMode: '@orion/Business/EditWindow/BackgroundModeManager',
  editWindow: '@orion/Business/EditWindow/EditWindowController',
  aiGraphManager: '@orion/Business/AIEffectWindow/AICombinationToolPanel/Core/Manager/AIGraphManager',
  aiGraphProject: '@orion/Business/AIEffectWindow/AICombinationToolPanel/Core/AIGraphProjectUtils',
};

// Scratch folder under the editor instance for exports this plugin makes and removes itself.
function scratchDir(lib, kind) {
  const base = lib.mod(M.ef).Resource.EditorFoundation.env.getInstancePath();
  return fs.mkdtempSync(path.join(base, `xiangsu-mcp-ext-${kind}-`));
}

// Export options of the two flows this plugin mirrors: the submit flow (exportEffectPackageForSubmit)
// and the toolbar's phone preview (MobilePreviewPopupContent).
const EXPORT_OPTIONS = {
  submit: { exportName: 'effect', zip: true, extra: { treeShakeIEJs: true, exportRemoteAssetJson: true } },
  preview: { exportName: 'effect', zip: true },
};

// Exports the effect package into a scratch folder; the size rule for remote assets is the submit
// flow's.
async function exportEffectPackage(lib, dir, flow = 'submit') {
  const project = lib.mod(M.ef).ProjectManager.getInstance().getActiveProject();
  if (!project) throw Error('NO_ACTIVE_PROJECT');
  const res = await project.effectExporter.exportEffectPackage(project.sceneManager.mainScene, dir, EXPORT_OPTIONS[flow]);
  const packagePath = res && res.packagePath;
  if (!packagePath || !fs.existsSync(packagePath)) throw Error(`EXPORT_FAILED: ${JSON.stringify(res && Object.keys(res))}`);
  let size = fs.statSync(packagePath).size;
  const remote = lib.mod(M.remoteAssets).RemoteAssetManager.getInstance();
  if (remote.getUsedRemoteAssets().length > 0) size = remote.getRemoveRemoteAssetsSize(packagePath);
  return { packagePath, size };
}

// Resolves with the first `event` payload on an editor event bus, or `onTimeout()` after `ms`.
function nextEvent(bus, event, ms, onTimeout) {
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      bus.off(event, handler);
      resolve(v);
    };
    const handler = (...args) => done({ args });
    const timer = setTimeout(() => done(onTimeout()), ms);
    bus.on(event, handler);
  });
}

function body(res, what) {
  const b = res && res.body;
  if (!b || b.statusCode !== 0) throw Error(`${what}_FAILED: statusCode=${b && b.statusCode} message=${(b && (b.message || b.statusMsg)) || ''}`);
  return b.data || {};
}

function sceneObjectPath(so) {
  const names = [];
  for (let p = so; p; p = p.parent) names.unshift(p.name);
  return names.join('/');
}

function editingScene(lib) {
  const EF = lib.mod(M.ef);
  const pm = EF.ProjectManager.getInstance();
  if (!pm.hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
  const service = lib.mod(M.scene).SceneModule.getEditingSceneService();
  const sceneEditor = service && service.sceneEditor;
  if (!sceneEditor) throw Error('NO_EDITING_SCENE');
  return { EF, service, sceneEditor, project: pm.getCurrentActiveProject() };
}

function sceneObjectSet(sceneEditor) {
  return new Set(sceneEditor.getAllSceneObjectEditors());
}

// Top-level objects present now but not in `before` (children of new objects are folded into them).
function addedObjectEditors(before, sceneEditor) {
  const added = sceneEditor.getAllSceneObjectEditors().filter((o) => !before.has(o));
  const fresh = new Set(added);
  return added.filter((o) => !fresh.has(o.parent));
}

function addedObjects(before, sceneEditor) {
  return addedObjectEditors(before, sceneEditor).map((o) => ({ name: o.name, object_path: sceneObjectPath(o) }));
}

function projectResources(project) {
  const all = project.resourceManager.getAllResources();
  const list = Array.isArray(all) ? all : [...all.values()];
  const root = project.path + path.sep;
  return list.filter((r) => r && r.assetPath && r.assetPath.startsWith(root) && !r.builtin);
}

// Folder an imported package lives in: Assets/<name>, or Assets/_DynamicAsset/<id> for shared dynamic assets.
function packageRoot(projectPath, assetPath) {
  const rel = path.relative(path.join(projectPath, 'Assets'), assetPath).split(path.sep);
  if (rel.length < 1 || rel[0] === '..' || rel[0] === '') return null;
  const depth = rel[0] === '_DynamicAsset' ? 2 : 1;
  if (rel.length < depth) return null;
  return path.join(projectPath, 'Assets', ...rel.slice(0, depth));
}

// Package folders an import created, recorded against the scene objects it added, so removing those
// objects later can also remove folders the scene never references (e.g. prefab templates).
const IMPORTS_DIR = path.join(process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), 'imports');

function importsFile(projectPath) {
  return path.join(IMPORTS_DIR, `${crypto.createHash('sha1').update(projectPath).digest('hex')}.json`);
}

function readImports(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(importsFile(projectPath), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeImports(projectPath, data) {
  fs.mkdirSync(IMPORTS_DIR, { recursive: true });
  const file = importsFile(projectPath);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function packageRootsAdded(project, beforePaths) {
  const roots = new Set();
  for (const r of projectResources(project)) {
    if (beforePaths.has(r.assetPath)) continue;
    const root = packageRoot(project.path, r.assetPath);
    if (root && !beforePaths.has(root)) roots.add(path.relative(project.path, root));
  }
  return [...roots];
}

function recordImport(project, objects, roots) {
  if (!objects.length || !roots.length) return;
  const data = readImports(project.path);
  for (const o of objects) data[String(o.guid)] = { name: o.name, package_folders: roots };
  writeImports(project.path, data);
}

// Resolves a full path or a unique trailing segment chain ("尖脸大眼/塑型画笔") to one entry of `candidates`.
function resolveByPath(candidates, objectPath, what) {
  if (typeof objectPath !== 'string' || !objectPath.trim()) throw Error('INVALID_OBJECT_PATH: object_path must be a non-empty string');
  const want = objectPath.trim().replace(/^\/+|\/+$/g, '');
  const hits = candidates.filter((c) => c.path === want || c.path.endsWith(`/${want}`));
  if (hits.length === 0) throw Error(`${what}_NOT_FOUND: ${want}; available: ${candidates.map((c) => c.path).join(' | ') || '(none)'}`);
  if (hits.length > 1) throw Error(`AMBIGUOUS_OBJECT_PATH: ${want} matches ${hits.map((c) => c.path).join(' | ')}; pass a longer path`);
  return hits[0];
}

module.exports = {
  M,
  scratchDir,
  exportEffectPackage,
  nextEvent,
  body,
  sceneObjectPath,
  editingScene,
  sceneObjectSet,
  addedObjectEditors,
  addedObjects,
  resolveByPath,
  projectResources,
  packageRoot,
  readImports,
  writeImports,
  packageRootsAdded,
  recordImport,
};
