// Every temp dir a test file creates lives under one root that is removed when the test process exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-test-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

export const tmpdir = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
