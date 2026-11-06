// Client side of the editor plugin RPC: discovers live plugin instances and calls them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTANCE_DIR = path.join(os.homedir(), '.xiangsu-mcp-ext', 'instances');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listInstances() {
  let names;
  try {
    names = fs.readdirSync(INSTANCE_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(INSTANCE_DIR, n), 'utf8')))
    .filter((s) => alive(s.pid));
}

async function post(instance, method, params, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${instance.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (!body.ok) throw Error(`PLUGIN_ERROR(${method}): ${body.error}`);
  return body.value;
}

// Selects the plugin instance by pid, or by the project path open in that window.
export async function resolveInstance({ pid, projectPath } = {}) {
  const live = listInstances();
  if (pid) {
    const hit = live.find((s) => s.pid === pid);
    if (!hit) throw Error(`NO_PLUGIN_INSTANCE: pid ${pid}`);
    return hit;
  }
  if (!projectPath) {
    if (live.length === 1) return live[0];
    throw Error(`AMBIGUOUS_INSTANCE: ${live.length} plugin instances; pass project_path`);
  }
  const want = fs.realpathSync(projectPath);
  const matches = [];
  for (const s of live) {
    const st = await post(s, 'status', {}, 5000);
    if (st.projectPath && fs.realpathSync(st.projectPath) === want) matches.push(s);
  }
  if (matches.length !== 1) throw Error(`NO_UNIQUE_PLUGIN_INSTANCE for ${projectPath}: ${matches.length} matches`);
  return matches[0];
}

export async function callPlugin(method, params = {}, { pid, projectPath, timeoutMs = 120000 } = {}) {
  const instance = await resolveInstance({ pid, projectPath });
  return post(instance, method, params, timeoutMs);
}
