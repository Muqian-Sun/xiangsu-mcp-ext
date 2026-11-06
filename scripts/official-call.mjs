// Dev helper: call a tool on 像塑's official MCP (streamable HTTP) without going through an IDE client.
// node scripts/official-call.mjs <tool> '<json args>'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.env.XIANGSU_MCP_URL ?? 'http://127.0.0.1:17320/mcp';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function rpc(body, session) {
  const res = await fetch(URL_, { method: 'POST', headers: session ? { ...headers, 'mcp-session-id': session } : headers, body: JSON.stringify(body) });
  const text = await res.text();
  const json = text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
  return { session: res.headers.get('mcp-session-id') ?? session, body: json ? JSON.parse(json) : null };
}

const [tool, raw] = process.argv.slice(2);
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xiangsu-mcp-ext-dev', version: '0.1.0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);
const out = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: raw ? JSON.parse(raw) : {} } }, init.session);
if (out.body?.error) {
  console.error(JSON.stringify(out.body.error, null, 2));
  process.exit(1);
}
for (const [i, c] of (out.body?.result?.content ?? []).entries()) {
  if (c.type === 'image') {
    const ext = (c.mimeType ?? 'image/png').split('/')[1];
    const file = path.join(os.tmpdir(), `xiangsu-${Date.now()}-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
    console.log(`[image] ${file}`);
  } else console.log(c.type === 'text' ? c.text : `[${c.type}]`);
}
if (out.body?.result?.isError) process.exit(1);
