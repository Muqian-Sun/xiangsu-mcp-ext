// Phone preview QR codes kept as files the user can scan. A file's name starts with the code's expiry
// (epoch ms), and expired files are deleted. They live in the state folder rather than the temp folder,
// which macOS empties of files older than three days (dirhelper) while a code stays valid for a week.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = /^(\d+)-.+\.png$/;

export class QrCodes {
  constructor({ stateDir = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), now = Date.now } = {}) {
    this.dir = path.join(stateDir, 'mobile-qr');
    this.now = now;
  }

  save(png, { project, expiresAt }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${expiresAt}-${project.replace(/[/\\:]/g, '_')}.png`);
    fs.writeFileSync(file, png);
    return file;
  }

  // Deletes the expired codes and returns their file names; files not named by save are left alone.
  prune() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const expired = names.filter((n) => FILE.test(n) && Number(FILE.exec(n)[1]) <= this.now());
    for (const n of expired) fs.rmSync(path.join(this.dir, n), { force: true });
    return expired;
  }
}
