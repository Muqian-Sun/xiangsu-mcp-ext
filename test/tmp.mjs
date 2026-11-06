// Every temp dir a test file creates lives under one root that is removed when the test process exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-test-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

export const tmpdir = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));

// Every test file imports this module first, so the plugin state directory (live editor windows,
// download registry) points at an empty folder before src/ modules read it: tests never see the
// windows of an editor running on this machine.
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
