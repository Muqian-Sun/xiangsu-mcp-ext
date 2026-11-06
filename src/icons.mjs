// Turns any image sips can read into the square PNG the icon slot takes: centre-cropped, then scaled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sniffImage } from './images.mjs';

// Size of the icons the editor's icon creation window saved in existing projects (360×360 PNG);
// measured on those files, not a documented requirement.
export const ICON_SIZE = 360;

const run = promisify(execFile);

export async function prepareIcon(src, { exec = run } = {}) {
  if (!path.isAbsolute(src) || !fs.existsSync(src)) throw Error(`IMAGE_NOT_FOUND: ${src}`);
  const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src]);
  const w = Number((/pixelWidth:\s*(\d+)/.exec(stdout) || [])[1]);
  const h = Number((/pixelHeight:\s*(\d+)/.exec(stdout) || [])[1]);
  if (!(w > 0 && h > 0)) throw Error(`NOT_AN_IMAGE: ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-icon-'));
  const out = path.join(dir, 'icon.png');
  try {
    const side = Math.min(w, h);
    await exec('sips', ['-s', 'format', 'png', '--cropToHeightWidth', String(side), String(side), src, '--out', out]);
    await exec('sips', ['-z', String(ICON_SIZE), String(ICON_SIZE), out, '--out', out]);
    if (sniffImage(fs.readFileSync(out)) !== 'image/png') throw Error(`ICON_CONVERT_FAILED: ${src}`);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { png: out, dir };
}
