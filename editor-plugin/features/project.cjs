'use strict';
// Project windows: ask the home process to open / create a project in a new window, and close this one.
const fs = require('fs');
const path = require('path');
const { M } = require('./common.cjs');

// openTemplate is how the homepage opens a work: no version-upgrade or save-copy prompts, and the
// project opens as unsaved-new.
const OPERATIONS = new Set(['createNew', 'openLocal', 'openTemplate']);
const CLOSE_DELAY_MS = 300;

const methods = {
  // scene_ready turns true once the editing scene exists; the project path is known earlier than that.
  projectState() {
    const EF = this.mod(M.ef);
    const pm = EF.ProjectManager.getInstance();
    if (!pm.hasActiveProject()) return { project_path: null, changed: false, scene_ready: false };
    const p = pm.getCurrentActiveProject();
    const service = this.mod(M.scene).SceneModule.getEditingSceneService();
    return { project_path: p.path || null, changed: !!p.isProjectChanged(), scene_ready: !!(service && service.sceneEditor) };
  },

  // The home process decides which window hosts the project (a new one, or an idle editor process);
  // the project in this window is never replaced.
  // `activity` (activity_id, activity_name, activity_enter_from, activity_type, task_type) is what the
  // task detail window passes; the editor writes it into the project once it has loaded, which is the
  // only way a project gets bound to a task.
  async projectLaunch({ operation, path: projectPath, template_id, activity }) {
    this.ensureCompatible('project');
    if (!OPERATIONS.has(operation)) throw Error(`INVALID_OPERATION: ${operation}; expected ${[...OPERATIONS].join(', ')}`);
    const withPath = operation !== 'createNew';
    if (withPath) {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw Error(`INVALID_PATH: ${operation} needs an absolute project folder`);
      if (!fs.existsSync(path.join(projectPath, 'effect.dyehpj'))) throw Error(`NOT_A_PROJECT: ${projectPath} has no effect.dyehpj`);
    }
    const extra = { enter_method: 'xiangsu_mcp_ext' };
    if (operation === 'openTemplate' && template_id !== undefined) extra.template_id = String(template_id);
    if (activity !== undefined) {
      const keys = ['activity_id', 'activity_name', 'activity_enter_from', 'activity_type', 'task_type'];
      if (!activity || !activity.activity_id || Object.keys(activity).some((k) => !keys.includes(k))) throw Error(`INVALID_ACTIVITY: expected ${keys.join(', ')} with an activity_id`);
      Object.assign(extra, activity, { enter_method: 'activity' });
    }
    // The same request the editor's own launchProject sends; the home process answers once the new
    // window has opened the project. At the window cap it answers reuseCurrent, after which the editor
    // would load the project into this window, so that is refused.
    const { OpenProjectFromEditCommand } = this.mod(M.ipc);
    const res = await this.mod(M.sender)
      .EditSender.getInstance()
      .sendCmdWithResponse(new OpenProjectFromEditCommand(operation, withPath ? projectPath : undefined, extra));
    const status = res && res.status;
    if (status === 'succeeded') return { requested: operation, path: withPath ? projectPath : null };
    if (status === 'reuseCurrent') throw Error(`WINDOW_LIMIT: all ${res.processCount} project windows 像塑 allows are in use; close one with project_close first`);
    if (status === 'cancelled' && res.reason === 'duplicateProject') throw Error(`PROJECT_ALREADY_OPEN: ${projectPath} is open in another window`);
    if (status === 'cancelled' || status === 'failed') throw Error(`LAUNCH_${status.toUpperCase()}: ${JSON.stringify(res)}`);
    throw Error(`UNEXPECTED_LAUNCH_RESPONSE: ${JSON.stringify(res)}`);
  },

  // Same path as the toolbar's "back to home": unloads the project and exits this window's process,
  // without a save prompt, so unsaved changes are refused unless discard_changes is set.
  projectClose({ discard_changes = false } = {}) {
    this.ensureCompatible('project');
    const state = this.projectState();
    if (state.changed && !discard_changes) throw Error(`PROJECT_HAS_UNSAVED_CHANGES: ${state.project_path}; save it first or pass discard_changes`);
    const close = this.mod(M.toolbar).closeProjectAndBackToHome;
    setTimeout(() => {
      Promise.resolve(close(false, false)).catch(() => {});
    }, CLOSE_DELAY_MS);
    return { closing: true, project_path: state.project_path, discarded_changes: state.changed };
  },
};

const METHODS = { project_state: 'projectState', project_launch: 'projectLaunch', project_close: 'projectClose' };

module.exports = { methods, METHODS };
