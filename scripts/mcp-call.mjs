// Dev helper: start a fresh stdio server and call one or more tools in sequence; images are written to
// <tmp>/xs-mcp-call, which each run clears first.
// node scripts/mcp-call.mjs <tool> '<json>' [<tool> '<json>' ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
// Images from the previous run are dropped so screenshots do not pile up in the temp dir.
const imageDir = path.join(os.tmpdir(), 'xs-mcp-call');
fs.rmSync(imageDir, { recursive: true, force: true });
fs.mkdirSync(imageDir);
const client = new Client({ name: 'mcp-call', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))] }));
let failed = false;
for (let i = 0; i < args.length; i += 2) {
  // Opening windows and downloading works take longer than the SDK's 60 s default.
  const res = await client.callTool({ name: args[i], arguments: JSON.parse(args[i + 1] ?? '{}') }, undefined, { timeout: 600000 });
  console.log(`--- ${args[i]} ${res.isError ? 'ERROR' : 'ok'}`);
  for (const [j, c] of res.content.entries()) {
    if (c.type === 'image') {
      const file = path.join(imageDir, `${i / 2}-${j}.${c.mimeType.split('/')[1]}`);
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`[image ${c.mimeType}] ${file}`);
    } else console.log(c.text);
  }
  failed ||= !!res.isError;
}
await client.close();
process.exit(failed ? 1 : 0);
