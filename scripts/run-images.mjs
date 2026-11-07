// Image output folder for the dev scripts: one folder per run under <tmp>/<name>, so concurrent runs
// (several agent sessions) never delete each other's images; runs older than an hour are removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP_MS = 60 * 60 * 1000;

export function runImageDir(name) {
  const root = path.join(os.tmpdir(), name);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    const p = path.join(root, entry);
    if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(root, `${process.pid}-`));
}
