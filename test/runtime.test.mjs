import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Runtime } = require('../editor-plugin/runtime.cjs');
const { CONFIG_PATH } = require('../editor-plugin/features/dev.cjs');
const LIBRARY = require.resolve('../editor-plugin/library.cjs');

test('library methods dispatch through the METHODS table', () => {
  const rt = new Runtime();
  assert.equal(typeof rt.resolve('library_apply'), 'function');
  assert.equal(rt.resolve('library_covers'), null);
  assert.equal(typeof rt.resolve('self_check'), 'function');
  for (const m of ['menu_preview', 'object_remove', 'resource_delete_unused', 'project_launch', 'project_close', 'project_state', 'works_by_effect', 'ai_combine_new', 'ai_combine_apply']) assert.equal(typeof rt.resolve(m), 'function', m);
  assert.equal(rt.resolve('constructor'), null);
  assert.equal(rt.resolve('nope'), null);
});

test('eval and describe follow the devEval flag on every call, in a runtime that is already running', async (t) => {
  const original = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;
  t.after(() => (original === null ? fs.rmSync(CONFIG_PATH, { force: true }) : fs.writeFileSync(CONFIG_PATH, original)));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ devEval: true }));
  const rt = new Runtime();
  assert.equal(await rt.resolve('eval')({ code: 'return 1 + 1' }), 2);
  assert.equal(rt.status().devEval, true);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ devEval: false }));
  await assert.rejects(async () => rt.resolve('eval')({ code: 'return 1' }), /EVAL_DISABLED/);
  assert.throws(() => rt.resolve('describe')({ module: 'x' }), /EVAL_DISABLED/);
  assert.equal(rt.status().devEval, false);
  fs.rmSync(CONFIG_PATH);
  await assert.rejects(async () => rt.resolve('eval')({ code: 'return 1' }), /EVAL_DISABLED/);
});

test('the library is reloaded when library.cjs or any feature module changes on disk, and only then', (t) => {
  const feature = require.resolve('../editor-plugin/features/menu.cjs');
  const dir = path.dirname(feature);
  const all = [LIBRARY, ...fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => path.join(dir, f))];
  const stamps = [LIBRARY, feature].map((f) => [f, fs.statSync(f)]);
  t.after(() => stamps.forEach(([f, s]) => fs.utimesSync(f, s.atime, s.mtime)));
  const newest = Math.max(...all.map((f) => fs.statSync(f).mtimeMs));
  const rt = new Runtime({});
  const first = rt.library;
  rt.resolve('library_nav');
  assert.equal(rt.library, first);
  fs.utimesSync(feature, new Date(), new Date(newest + 5000));
  rt.resolve('menu_list');
  const second = rt.library;
  assert.notEqual(second, first);
  fs.utimesSync(LIBRARY, new Date(), new Date(newest + 10000));
  rt.resolve('library_nav');
  assert.notEqual(rt.library, second);
});
