// Local side of the works tools: reference copies, a file inventory an agent can read from, and a
// registry of everything downloaded so it can be deleted again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Editor cache, regenerated on open and useless as a reference.
const SKIP_DIRS = new Set(['Library']);
const MAX_FILES = 500;
// Picked, not measured: long enough to study a work within a working day, short enough that other
// people's projects do not pile up. works_cleanup deletes earlier.
export const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

// Resolves symlinks through the nearest existing ancestor, so a path that is gone (or not yet there)
// still compares equal to its live siblings (/tmp vs /private/tmp on macOS).
const real = (p) => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  }
};
const inside = (child, parent) => {
  const c = real(child);
  const p = real(parent);
  return c === p || c.startsWith(p + path.sep);
};

// The editor unzips every work into ProjectCreatedTmp/CreatedFromTemplate/<guid>/<name>; the guid
// folder is ours alone. Anywhere else only the project folder itself is claimed.
export function editorRoot(projectPath) {
  const guid = path.dirname(projectPath);
  return path.basename(path.dirname(guid)) === 'CreatedFromTemplate' ? guid : projectPath;
}

export class Downloads {
  constructor({ stateDir = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), now = Date.now } = {}) {
    this.file = path.join(stateDir, 'works-downloads.json');
    this.now = now;
  }

  list() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  write(entries) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(entries, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  record(entry) {
    this.write([...this.list().filter((e) => e.path !== entry.path), { ...entry, created_at: this.now() }]);
  }

  // Deletes recorded downloads (all, the ones containing the given paths, or those older than
  // olderThanMs), keeping any that an editor window has open. A path inside no recorded download is
  // refused, never deleted.
  cleanup({ paths, olderThanMs, openPaths = [] } = {}) {
    const entries = this.list();
    if (paths) {
      const unknown = paths.filter((p) => !entries.some((e) => inside(p, e.path)));
      if (unknown.length) throw Error(`NOT_A_DOWNLOAD: ${unknown.join(' | ')}; only paths returned by works_download / works_open can be deleted`);
    }
    const chosen = (e) => (paths ? paths.some((p) => inside(p, e.path)) : olderThanMs === undefined || this.now() - e.created_at >= olderThanMs);
    const out = { deleted: [], kept_open: [], already_gone: [] };
    const keep = [];
    for (const e of entries) {
      if (!chosen(e)) keep.push(e);
      else if (!fs.existsSync(e.path)) out.already_gone.push(e.path);
      else if (openPaths.some((o) => o && inside(o, e.path))) {
        out.kept_open.push(e.path);
        keep.push(e);
      } else {
        fs.rmSync(e.path, { recursive: true, force: true });
        out.deleted.push(e.path);
      }
    }
    this.write(keep);
    return out;
  }
}

export function checkTarget(dest) {
  if (!path.isAbsolute(dest)) throw Error(`INVALID_PATH: dest must be absolute: ${dest}`);
  if (fs.existsSync(dest) && (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length)) throw Error(`TARGET_NOT_EMPTY: ${dest}`);
  return path.resolve(dest);
}

// A copy that fails midway is removed only when this call created the folder.
export function copyProject(src, dest) {
  const abs = checkTarget(dest);
  const existed = fs.existsSync(abs);
  try {
    fs.cpSync(src, abs, { recursive: true, filter: (from) => !SKIP_DIRS.has(path.relative(src, from).split(path.sep)[0]) });
  } catch (e) {
    if (!existed) fs.rmSync(abs, { recursive: true, force: true });
    throw e;
  }
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
