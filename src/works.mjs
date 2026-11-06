// Local side of works_download: an optional reference copy of the downloaded project and a file
// inventory an agent can read from.
import fs from 'node:fs';
import path from 'node:path';

// Editor cache, regenerated on open and useless as a reference.
const SKIP_DIRS = new Set(['Library']);
const MAX_FILES = 500;

export function checkTarget(dest) {
  if (!path.isAbsolute(dest)) throw Error(`INVALID_PATH: dest must be absolute: ${dest}`);
  if (fs.existsSync(dest) && (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length)) throw Error(`TARGET_NOT_EMPTY: ${dest}`);
  return path.resolve(dest);
}

export function copyProject(src, dest) {
  const abs = checkTarget(dest);
  fs.cpSync(src, abs, { recursive: true, filter: (from) => !SKIP_DIRS.has(path.relative(src, from).split(path.sep)[0]) });
  return abs;
}

export function outlineProject(root) {
  const files = [];
  const byExt = {};
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        if (!(dir === root && SKIP_DIRS.has(e.name))) walk(full);
      } else if (e.isFile()) {
        const size = fs.statSync(full).size;
        const ext = path.extname(e.name).toLowerCase() || '(none)';
        byExt[ext] = (byExt[ext] || 0) + 1;
        bytes += size;
        files.push({ path: rel, size });
      }
    }
  };
  walk(root);
  return { file_count: files.length, total_bytes: bytes, by_extension: byExt, files: files.slice(0, MAX_FILES), files_truncated: files.length > MAX_FILES };
}
