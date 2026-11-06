// Dev helper: node scripts/call.mjs <method> '<json params>' [--pid N]
// Code for `eval` can be passed from a file with --code-file path.
import fs from 'node:fs';
import { callPlugin } from '../src/bridge.mjs';

const args = process.argv.slice(2);
const pidIdx = args.indexOf('--pid');
const pid = pidIdx >= 0 ? Number(args.splice(pidIdx, 2)[1]) : undefined;
const fileIdx = args.indexOf('--code-file');
const codeFile = fileIdx >= 0 ? args.splice(fileIdx, 2)[1] : undefined;
const [method, raw] = args;
const params = raw ? JSON.parse(raw) : {};
if (codeFile) params.code = fs.readFileSync(codeFile, 'utf8');
const value = await callPlugin(method, params, { pid });
console.log(JSON.stringify(value, null, 2));
