import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Runtime } = require('../editor-plugin/runtime.cjs');
const LIBRARY = require.resolve('../editor-plugin/library.cjs');

test('library methods dispatch through the METHODS table and dev methods stay off', () => {
  const rt = new Runtime({ devEval: false });
  assert.equal(typeof rt.resolve('library_apply'), 'function');
  assert.equal(typeof rt.resolve('library_covers'), 'function');
  assert.equal(typeof rt.resolve('self_check'), 'function');
  assert.equal(rt.resolve('eval'), null);
  assert.equal(rt.resolve('constructor'), null);
  assert.equal(rt.resolve('nope'), null);
  assert.equal(typeof new Runtime({ devEval: true }).resolve('eval'), 'function');
});

test('library.cjs is reloaded when it changes on disk, and only then', (t) => {
  const { atime, mtime } = fs.statSync(LIBRARY);
  t.after(() => fs.utimesSync(LIBRARY, atime, mtime));
  const rt = new Runtime({});
  const first = rt.library;
  rt.resolve('library_nav');
  assert.equal(rt.library, first);
  fs.utimesSync(LIBRARY, atime, new Date(mtime.getTime() + 5000));
  rt.resolve('library_nav');
  assert.notEqual(rt.library, first);
});
