// Installs (idempotently) the editor plugin into 像塑's local plugin folder on macOS.
// Other plugins listed in plugins.config.json are preserved; older versions of this plugin are replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAME = 'XiangsuMcpExt';
const VERSION = '0.3.0';
const repo = fileURLToPath(new URL('..', import.meta.url));
const appRoot = process.env.XIANGSU_APP ?? '/Applications/Douyin AR.app';
const editorVersion = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appRoot, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const pluginRoot = path.join(os.homedir(), 'Library/Application Support/DouyinAR/Plugins', `v${editorVersion}`, 'Local');
if (!fs.existsSync(pluginRoot)) throw Error(`plugin root not found: ${pluginRoot} (start 像塑 once first)`);

const configPath = path.join(repo, 'config.local.json');
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ devEval: false }, null, 2));

const removed = [];
for (const entry of fs.readdirSync(pluginRoot)) {
  const base = entry.split('@')[0];
  if (base === NAME) {
    fs.rmSync(path.join(pluginRoot, entry), { recursive: true, force: true });
    removed.push(entry);
  }
}

const dest = path.join(pluginRoot, `${NAME}@${VERSION}`);
fs.mkdirSync(dest, { recursive: true });
const entry = `'use strict';
const { Runtime, log } = require(${JSON.stringify(path.join(repo, 'editor-plugin/runtime.cjs'))});
const config = require(${JSON.stringify(configPath)});
module.exports = class {
  initPlugin() {
    if (!process.argv.includes('--projectType=project')) return;
    try { this.runtime = new Runtime(config); this.runtime.start(); } catch (e) { log('init failed', e && e.stack); }
  }
  deinitPlugin() { this.runtime && this.runtime.stop(); }
};
`;
fs.writeFileSync(path.join(dest, 'index.js'), entry);
fs.writeFileSync(
  path.join(dest, 'plugin.manifest.json'),
  JSON.stringify({ name: NAME, version: VERSION, description: 'Local RPC bridge for xiangsu-mcp-ext', requirements: { orionSDK: '', apis: {} }, entry: 'index.js', builderVersion: 1 }, null, 2),
);

const listPath = path.join(pluginRoot, 'plugins.config.json');
let list = { plugins: [] };
if (fs.existsSync(listPath)) {
  list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  fs.copyFileSync(listPath, `${listPath}.bak-${Date.now()}`);
}
list.plugins = (list.plugins || []).filter((p) => p.name !== NAME);
list.plugins.push({ name: NAME, version: VERSION, loadOnStartup: true });
fs.writeFileSync(listPath, JSON.stringify(list, null, 2));

console.log(JSON.stringify({ editorVersion, plugin: dest, removed, config: configPath, requiresWindowReopen: true }, null, 2));
