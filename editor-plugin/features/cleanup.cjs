'use strict';
// Removing a scene object together with the project resources only it used. Two sources of candidates:
// - resources whose editor guid the serialized scene (main.scene + .extra) referenced before the removal
//   and no longer does afterwards;
// - package folders that library_apply / menu_add recorded for the removed objects (e.g. prefab templates,
//   which the scene never references).
// A folder is only deleted when nothing inside it is still referenced. Resources reached only indirectly
// (e.g. a texture inside a material file) are never treated as orphans.
// Instantiating a package also gives the editor folders named after its objects (<name>_滤镜, _美型,
// _美妆, …) that only reach the disk when a save runs while the object is still in the scene; once the
// object is removed, the next save drops them. Those are reported apart and never deleted.
const fs = require('fs');
const path = require('path');
const { editingScene, sceneObjectPath, resolveByPath, projectResources, packageRoot, readImports, writeImports } = require('./common.cjs');

function isFolder(r) {
  return r.constructor && r.constructor.name === 'ResItemFolder';
}

function sceneText(sceneEditor) {
  const data = sceneEditor._getCurrentMainSceneFileData();
  if (!data || typeof data.values !== 'function' || data.size === 0) throw Error('SCENE_DATA_UNAVAILABLE: could not serialize the current scene');
  return [...data.values()].map((v) => Buffer.from(v).toString('utf8')).join('\n');
}

function referencedGuids(sceneEditor, resources) {
  const text = sceneText(sceneEditor);
  return new Set(resources.filter((r) => !isFolder(r) && text.includes(String(r.guid))).map((r) => String(r.guid)));
}

const rel = (project, p) => path.relative(project.path, p);
const within = (p, folder) => p === folder || p.startsWith(folder + path.sep);

// Deletes the given project resources / folders, refusing any that the current scene still references.
function deletePaths(project, sceneEditor, relPaths) {
  const rm = project.resourceManager;
  const resources = projectResources(project);
  const used = referencedGuids(sceneEditor, resources);
  const abs = relPaths.map((p) => path.resolve(project.path, p));
  for (const [i, p] of abs.entries()) {
    if (!(p + path.sep).startsWith(path.join(project.path, 'Assets') + path.sep)) throw Error(`OUTSIDE_ASSETS: ${relPaths[i]}`);
    if (!rm.getResourceItemByAssetPath(p)) throw Error(`RESOURCE_NOT_FOUND: ${relPaths[i]}`);
    const inUse = resources.filter((x) => within(x.assetPath, p) && used.has(String(x.guid)));
    if (inUse.length) throw Error(`RESOURCE_IN_USE: ${relPaths[i]} (${inUse.map((x) => rel(project, x.assetPath)).join(', ')})`);
  }
  for (const p of abs) if (rm.getResourceItemByAssetPath(p)) rm.deleteResourceItemByPath(p);
  const left = abs.filter((p) => rm.getResourceItemByAssetPath(p));
  if (left.length) throw Error(`RESOURCE_DELETE_INCOMPLETE: ${left.map((p) => rel(project, p)).join(', ')}`);
  return abs.map((p) => rel(project, p));
}

const methods = {
  resourceDeleteUnused({ paths }) {
    if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p)) throw Error('INVALID_PATHS: pass project-relative resource paths');
    const { sceneEditor, project } = editingScene(this);
    return { deleted: deletePaths(project, sceneEditor, paths) };
  },

  async objectRemove({ object_path, delete_unused_resources = false }) {
    const { service, sceneEditor, project } = editingScene(this);
    const candidates = sceneEditor.getAllSceneObjectEditors().filter((o) => o.parent).map((o) => ({ so: o, path: sceneObjectPath(o) }));
    const target = resolveByPath(candidates, object_path, 'OBJECT');
    const removedObjects = sceneEditor.getAllSceneObjectEditors().filter((o) => {
      for (let p = o; p; p = p.parent) if (p === target.so) return true;
      return false;
    });
    const resources = projectResources(project);
    const before = referencedGuids(sceneEditor, resources);

    const err = service.removeSceneObjects({ sceneObjects: [target.so], supportUndo: true });
    if (err && err.code !== undefined) throw Error(`REMOVE_FAILED: ${target.path} code=${err.code}`);
    if (sceneEditor.getAllSceneObjectEditors().includes(target.so)) throw Error(`REMOVE_NOT_APPLIED: ${target.path} is still in the scene`);

    const after = referencedGuids(sceneEditor, resources);
    const stillUsed = (folder) => resources.some((x) => !isFolder(x) && within(x.assetPath, folder) && after.has(String(x.guid)));
    const orphans = resources.filter((r) => before.has(String(r.guid)) && !after.has(String(r.guid)));

    const imports = readImports(project.path);
    const recordKeys = removedObjects.map((o) => String(o.guid)).filter((g) => imports[g]);
    const folders = new Set();
    for (const r of orphans) {
      const root = packageRoot(project.path, r.assetPath);
      if (root && root !== r.assetPath && !stillUsed(root)) folders.add(root);
    }
    for (const g of recordKeys) {
      for (const f of imports[g].package_folders) {
        const abs = path.join(project.path, f);
        if (project.resourceManager.getResourceItemByAssetPath(abs) && !stillUsed(abs)) folders.add(abs);
      }
    }
    // Deleting a package folder deletes everything in it, so loose orphans are the ones outside those folders.
    const covered = (p) => [...folders].some((f) => within(p, f));
    const leftovers = [...folders, ...orphans.filter((r) => !covered(r.assetPath)).map((r) => r.assetPath)];
    const unused = leftovers.filter((p) => fs.existsSync(p)).map((p) => rel(project, p));
    const report = {
      removed_object: target.path,
      orphaned_resources: orphans.map((r) => rel(project, r.assetPath)),
      unused_paths: unused,
      editor_only_paths: leftovers.filter((p) => !fs.existsSync(p)).map((p) => rel(project, p)),
      resources_deleted: [],
    };
    if (recordKeys.length) {
      for (const g of recordKeys) delete imports[g];
      writeImports(project.path, imports);
    }
    if (!delete_unused_resources || !unused.length) return report;
    return { ...report, resources_deleted: deletePaths(project, sceneEditor, unused) };
  },
};

const METHODS = { object_remove: 'objectRemove', resource_delete_unused: 'resourceDeleteUnused' };

module.exports = { methods, METHODS };
