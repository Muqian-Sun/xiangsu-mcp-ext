import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Projects } from '../src/projects.mjs';

const tmp = () => tmpdir('xs-p-');

// A fake editor: plugin windows keyed by pid, plus an official MCP mapping pids to instance ids.
function world() {
  const windows = new Map([[100, path.join(tmp(), 'S16')]]);
  const calls = [];
  const ready = new Map();
  let readyAfter = 2;
  const official = {
    callJson: async (name, args) => {
      calls.push(['official', name, args]);
      if (name === 'list_instances') return { instances: [...windows].map(([pid, p], i) => ({ instance_id: String(i + 1), generation: `${pid}-123`, project_path: p })) };
      if (name === 'save_project') {
        const pid = [...windows].find(([, p], i) => String(i + 1) === args.instance_id)[0];
        windows.set(pid, args.path);
        return { save_status: 'succeeded' };
      }
      throw Error(`unexpected ${name}`);
    },
  };
  const d = {
    official,
    sleep: async () => {},
    openTimeoutMs: 50,
    closeTimeoutMs: 50,
    instanceTimeoutMs: 50,
    saveTimeoutMs: 50,
    listInstances: () => [...windows.keys()].map((pid) => ({ pid })),
    openWithApp: async (file) => {
      calls.push(['open', file]);
      windows.set(300, path.dirname(file));
    },
    callPlugin: async (method, params, opts) => {
      calls.push(['plugin', method, params, opts]);
      if (method === 'status') return { projectPath: windows.get(opts.pid) };
      if (method === 'project_state') {
        const n = (ready.get(opts.pid) ?? 0) + 1;
        ready.set(opts.pid, n);
        return { scene_ready: n >= readyAfter };
      }
      if (method === 'project_launch' && params.operation !== 'createNew') windows.set(200, params.path);
      if (method === 'project_launch' && params.operation === 'createNew') windows.set(201, '/x/Instances/Instance2/ProjectCreatedTmp/未命名');
      if (method === 'project_close') {
        const p = windows.get(opts.pid);
        windows.delete(opts.pid);
        return { closing: true, project_path: p, discarded_changes: !!params.discard_changes };
      }
      return {};
    },
  };
  return { d, windows, calls, ready, setReadyAfter: (n) => (readyAfter = n) };
}

function project() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'effect.dyehpj'), '{}');
  return dir;
}

test('open asks an existing window to open the project and waits for it', async () => {
  const { d, calls } = world();
  const dir = project();
  const out = await new Projects(d).open({ path: dir });
  assert.deepEqual(out, { already_open: false, pid: 200, project_path: dir, instance_id: '2' });
  assert.deepEqual(calls.find((c) => c[1] === 'project_launch').slice(1, 3), ['project_launch', { operation: 'openLocal', path: dir }]);
});

test('open with a template id launches openTemplate and needs an open window', async () => {
  const { d, windows, calls } = world();
  const dir = project();
  const out = await new Projects(d).open({ path: dir, template_id: '9' });
  assert.equal(out.pid, 200);
  assert.deepEqual(calls.find((c) => c[1] === 'project_launch')[2], { operation: 'openTemplate', path: dir, template_id: '9' });
  windows.clear();
  await assert.rejects(new Projects(d).open({ path: project(), template_id: '9' }), /NO_EDITOR_WINDOW/);
  assert.ok(!calls.some((c) => c[0] === 'open'));
});

test('open returns the window that already shows the project', async () => {
  const { d, windows, calls } = world();
  const dir = project();
  windows.set(150, dir);
  const out = await new Projects(d).open({ path: dir });
  assert.equal(out.already_open, true);
  assert.equal(out.pid, 150);
  assert.ok(!calls.some((c) => c[1] === 'project_launch'));
});

test('open falls back to the app when no window is open, and rejects non-projects', async () => {
  const { d, windows, calls } = world();
  windows.clear();
  const dir = project();
  const out = await new Projects(d).open({ path: dir });
  assert.equal(out.pid, 300);
  assert.deepEqual(calls.find((c) => c[0] === 'open'), ['open', path.join(dir, 'effect.dyehpj')]);
  await assert.rejects(new Projects(d).open({ path: tmp() }), /NOT_A_PROJECT/);
});

test('open times out when the window never shows the project', async () => {
  const { d } = world();
  d.callPlugin = async (method, params, opts) => (method === 'status' ? { projectPath: '/somewhere/else' } : {});
  await assert.rejects(new Projects(d).open({ path: project() }), /OPEN_TIMEOUT/);
});

test('create opens a new window and saves it to the target through the official MCP', async () => {
  const { d, windows, calls } = world();
  const target = path.join(tmp(), '新工程');
  const out = await new Projects(d).create({ path: target });
  assert.deepEqual(out, { pid: 201, instance_id: '2', project_path: target });
  assert.equal(windows.get(201), target);
  const save = calls.find((c) => c[1] === 'save_project');
  assert.deepEqual(save[2], { instance_id: '2', path: target, intention: '新建工程首次保存' });
});

test('create refuses non-empty targets and needs an open window', async () => {
  const { d, windows } = world();
  const busy = tmp();
  fs.writeFileSync(path.join(busy, 'x'), '');
  await assert.rejects(new Projects(d).create({ path: busy }), /TARGET_NOT_EMPTY/);
  windows.clear();
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /NO_EDITOR_WINDOW/);
});

test('create fails when the save does not move the window to the target', async () => {
  const { d } = world();
  const official = d.official.callJson;
  d.official.callJson = async (name, args) => (name === 'save_project' ? { save_status: 'succeeded' } : official(name, args));
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /SAVE_NOT_APPLIED/);
});

test('close targets the window by instance id and waits for it to exit', async () => {
  const { d, windows } = world();
  const s16 = windows.get(100);
  const out = await new Projects(d).close({ instance_id: '1', discard_changes: true });
  assert.deepEqual(out, { closed: true, pid: 100, project_path: s16, discarded_changes: true });
  assert.equal(windows.has(100), false);
});

test('close reports windows that keep running and unknown instances', async () => {
  const { d } = world();
  const call = d.callPlugin;
  d.callPlugin = async (method, params, opts) => (method === 'project_close' ? { closing: true } : call(method, params, opts));
  await assert.rejects(new Projects(d).close({ instance_id: '1' }), /CLOSE_TIMEOUT/);
  await assert.rejects(new Projects(d).close({ instance_id: '9' }), /UNKNOWN_INSTANCE: 9/);
});

test('open and create wait until the new window scene is editable', async () => {
  const { d, ready, setReadyAfter } = world();
  const dir = project();
  await new Projects(d).open({ path: dir });
  assert.equal(ready.get(200), 2);
  setReadyAfter(Infinity);
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /SCENE_NOT_READY: window 201/);
});
