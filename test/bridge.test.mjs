import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { listInstances } from '../src/bridge.mjs';

const DIR = path.join(process.env.XIANGSU_MCP_EXT_STATE, 'instances');
const PROCESS_START = Date.now() - process.uptime() * 1000;

function writeRecords(records) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const r of records) fs.writeFileSync(path.join(DIR, `${r.pid}.json`), JSON.stringify({ port: 1, token: 't', ...r }));
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

test('no instance directory means no windows', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  assert.deepEqual(listInstances(), []);
});

test('a record written after its process started is a live window', () => {
  writeRecords([{ pid: process.pid, startedAt: Date.now() }]);
  assert.deepEqual(listInstances().map((s) => s.pid), [process.pid]);
});

test('a record whose pid now belongs to a process started later is stale', () => {
  writeRecords([{ pid: process.pid, startedAt: PROCESS_START - 60000 }]);
  assert.deepEqual(listInstances(), []);
});

test('a record whose process has exited is stale, and does not hide the live ones', async () => {
  writeRecords([{ pid: await exitedPid(), startedAt: Date.now() }, { pid: process.pid, startedAt: Date.now() }]);
  assert.deepEqual(listInstances().map((s) => s.pid), [process.pid]);
});

test('records whose processes have all exited give no windows', async () => {
  writeRecords([{ pid: await exitedPid(), startedAt: Date.now() }]);
  assert.deepEqual(listInstances(), []);
});
