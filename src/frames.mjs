// Preview frames saved to disk so they can be shown to the user or compared later, with optional cropping.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Picked, not measured: frames are for the current task; a day covers it without piling up.
export const FRAMES_TTL_MS = 24 * 60 * 60 * 1000;

// A fresh folder per call under <tmp>/xs-preview-frames; folders older than the TTL are removed first.
export function framesDir({ root = path.join(os.tmpdir(), 'xs-preview-frames'), now = Date.now() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    if (now - fs.statSync(p).mtimeMs > FRAMES_TTL_MS) fs.rmSync(p, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(root, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-`));
}

// `box` is { x, y, width, height } as fractions of the frame (0–1), so it does not depend on the
// screenshot resolution. sips takes the size as height width and the offset as y x.
export async function cropImage(file, box, { exec = run } = {}) {
  const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const w = Number((/pixelWidth:\s*(\d+)/.exec(stdout) || [])[1]);
  const h = Number((/pixelHeight:\s*(\d+)/.exec(stdout) || [])[1]);
  if (!(w > 0 && h > 0)) throw Error(`NOT_AN_IMAGE: ${file}`);
  const x = Math.round(box.x * w);
  const y = Math.round(box.y * h);
  const cw = Math.max(1, Math.min(w - x, Math.round(box.width * w)));
  const ch = Math.max(1, Math.min(h - y, Math.round(box.height * h)));
  await exec('sips', ['-c', String(ch), String(cw), '--cropOffset', String(y), String(x), file, '--out', file]);
  return { width: cw, height: ch };
}
