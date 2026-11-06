// Live end-to-end check against a running 像塑 window with the plugin loaded.
// node scripts/e2e.mjs <project_path> <search query> [title to apply]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [projectPath, query, title = query] = process.argv.slice(2);
const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content[0].text;
  console.log(`--- ${name} ${JSON.stringify(args)} ${res.isError ? 'ERROR' : 'ok'}`);
  console.log(body.length > 1500 ? body.slice(0, 1500) + '…' : body);
  return { res, json: res.isError ? null : JSON.parse(body) };
};

await call('ext_status', {});
const nav = await call('library_nav', { project_path: projectPath });
console.log('panels:', nav.json.panels.map((p) => p.panel_key).join(','));
const found = await call('library_search', { project_path: projectPath, query });
const hit = found.json.items.find((i) => i.title === title);
if (!hit) throw Error(`no search hit titled ${title}`);
await call('library_apply', { project_path: projectPath, template_id: hit.template_id });
const bad = await call('library_apply', { project_path: projectPath, template_id: '0' });
if (!bad.res.isError) throw Error('expected an error for unknown template');
await client.close();
