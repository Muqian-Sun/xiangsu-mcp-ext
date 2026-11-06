// Opening, creating and closing project windows. The plugin asks the home process to open windows;
// this module waits for the resulting window and finishes the job (e.g. first save of a new project).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const BUNDLE_ID = 'com.ies.dyeh';
const TMP_MARK = `${path.sep}ProjectCreatedTmp${path.sep}`;

export function openWithApp(file) {
  return promisify(execFile)('open', ['-b', BUNDLE_ID, file]);
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
};
const samePath = (a, b) => !!a && !!b && real(a) === real(b);

export async function waitFor(fn, { timeoutMs, intervalMs = 1000, sleep }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

export class Projects {
  constructor(d) {
    this.d = d;
  }

  // Live plugin windows with the project each one shows.
  async windows() {
    const rows = [];
    for (const s of this.d.listInstances()) {
      try {
        const st = await this.d.callPlugin('status', {}, { pid: s.pid, timeoutMs: 5000 });
        rows.push({ pid: s.pid, project_path: st.projectPath || null });
      } catch (_) {}
    }
    return rows;
  }

  async officialInstances() {
    const { instances = [] } = await this.d.official.callJson('list_instances', {});
    return instances.map((i) => ({ ...i, pid: Number(String(i.generation || '').split('-')[0]) }));
  }

  async instanceIdForPid(pid, timeoutMs = 0) {
    const hit = await waitFor(async () => (await this.officialInstances().catch(() => [])).find((i) => i.pid === pid), { timeoutMs, sleep: this.d.sleep });
    return hit ? hit.instance_id : null;
  }

  // Our tools accept either the official instance_id or a project path; both end up as a project path.
  async resolveProjectPath({ project_path, instance_id }) {
    if (instance_id === undefined) return project_path;
    const hit = (await this.officialInstances()).find((i) => String(i.instance_id) === String(instance_id));
    if (!hit) throw Error(`UNKNOWN_INSTANCE: ${instance_id}`);
    if (project_path && !samePath(project_path, hit.project_path)) throw Error(`INSTANCE_PROJECT_MISMATCH: instance ${instance_id} has ${hit.project_path}`);
    return hit.project_path;
  }

  // A window reports its project path before the scene is editable; tools need the scene.
  async waitReady(pid) {
    const ok = await waitFor(
      async () => {
        try {
          return (await this.d.callPlugin('project_state', {}, { pid, timeoutMs: 5000 })).scene_ready;
        } catch (_) {
          return false;
        }
      },
      { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep },
    );
    if (!ok) throw Error(`SCENE_NOT_READY: window ${pid} did not finish loading its scene`);
  }

  async open({ path: target }) {
    const abs = path.resolve(target);
    if (!fs.existsSync(path.join(abs, 'effect.dyehpj'))) throw Error(`NOT_A_PROJECT: ${abs} has no effect.dyehpj`);
    const windows = await this.windows();
    const already = windows.find((w) => samePath(w.project_path, abs));
    if (already) return { already_open: true, pid: already.pid, project_path: already.project_path, instance_id: await this.instanceIdForPid(already.pid, this.d.instanceTimeoutMs) };
    if (windows.length) await this.d.callPlugin('project_launch', { operation: 'openLocal', path: abs }, { pid: windows[0].pid });
    else await this.d.openWithApp(path.join(abs, 'effect.dyehpj'));
    const w = await waitFor(async () => (await this.windows()).find((x) => samePath(x.project_path, abs)), { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep });
    if (!w) throw Error(`OPEN_TIMEOUT: ${abs} did not finish opening; 像塑 may be showing a dialog (e.g. version upgrade) that needs a click`);
    await this.waitReady(w.pid);
    return { already_open: false, pid: w.pid, project_path: w.project_path, instance_id: await this.instanceIdForPid(w.pid, this.d.instanceTimeoutMs) };
  }

  async create({ path: target }) {
    const abs = path.resolve(target);
    if (fs.existsSync(abs) && (!fs.statSync(abs).isDirectory() || fs.readdirSync(abs).length)) throw Error(`TARGET_NOT_EMPTY: ${abs}`);
    const windows = await this.windows();
    if (!windows.length) throw Error('NO_EDITOR_WINDOW: open any project first; new projects are created through an open editor window');
    const seen = new Set(windows.map((w) => `${w.pid}|${w.project_path}`));
    await this.d.callPlugin('project_launch', { operation: 'createNew' }, { pid: windows[0].pid });
    const w = await waitFor(
      async () => (await this.windows()).find((x) => !seen.has(`${x.pid}|${x.project_path}`) && x.project_path && x.project_path.includes(TMP_MARK)),
      { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep },
    );
    if (!w) throw Error('NEW_PROJECT_TIMEOUT: no new project window appeared');
    await this.waitReady(w.pid);
    const instance_id = await this.instanceIdForPid(w.pid, this.d.instanceTimeoutMs);
    if (instance_id === null) throw Error(`NO_OFFICIAL_INSTANCE: window ${w.pid} is not visible to the official MCP`);
    const saved = await this.d.official.callJson('save_project', { instance_id, path: abs, intention: '新建工程首次保存' });
    if (saved.save_status !== 'succeeded') throw Error(`SAVE_FAILED: ${JSON.stringify(saved)}`);
    const moved = await waitFor(async () => (await this.windows()).find((x) => x.pid === w.pid && samePath(x.project_path, abs)), { timeoutMs: this.d.saveTimeoutMs, sleep: this.d.sleep });
    if (!moved) throw Error(`SAVE_NOT_APPLIED: window ${w.pid} still shows ${w.project_path}`);
    return { pid: w.pid, instance_id, project_path: abs };
  }

  async close(args) {
    const projectPath = await this.resolveProjectPath(args);
    const windows = await this.windows();
    const hits = projectPath ? windows.filter((w) => samePath(w.project_path, projectPath)) : windows;
    if (hits.length !== 1) throw Error(projectPath ? `NO_UNIQUE_WINDOW for ${projectPath}: ${hits.length} matches` : `AMBIGUOUS_INSTANCE: ${windows.length} windows; pass project_path or instance_id`);
    const { pid } = hits[0];
    const res = await this.d.callPlugin('project_close', { discard_changes: !!args.discard_changes }, { pid });
    const gone = await waitFor(() => !this.d.listInstances().some((s) => s.pid === pid), { timeoutMs: this.d.closeTimeoutMs, sleep: this.d.sleep });
    if (!gone) throw Error(`CLOSE_TIMEOUT: window ${pid} is still running`);
    return { closed: true, pid, project_path: res.project_path, discarded_changes: res.discarded_changes };
  }
}
