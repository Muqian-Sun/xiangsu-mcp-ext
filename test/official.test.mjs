import test from 'node:test';
import assert from 'node:assert/strict';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { OfficialMcp } from '../src/official.mjs';

function fakeConnector(script) {
  const log = { connects: 0, closes: 0 };
  const connect = async () => {
    log.connects += 1;
    const n = log.connects;
    const s = script(n);
    if (s.refuse) throw Error('ECONNREFUSED');
    return {
      listTools: async () => ({ tools: s.tools ?? [{ name: 'get_scene' }] }),
      callTool: async (params) => s.call(params, n),
      close: async () => {
        log.closes += 1;
      },
    };
  };
  return { connect, log };
}

test('reconnects once after a transport failure and retries the call', async () => {
  const { connect, log } = fakeConnector(() => ({
    call: (p, n) => {
      if (n === 1) throw Error('fetch failed');
      return { content: [{ type: 'text', text: `ok ${p.name}` }] };
    },
  }));
  const o = new OfficialMcp({ connect });
  const res = await o.callTool('get_scene', { instance_id: '1' });
  assert.equal(res.content[0].text, 'ok get_scene');
  assert.equal(log.connects, 2);
  assert.equal(log.closes, 1);
});

test('does not retry protocol errors from the official server', async () => {
  const { connect, log } = fakeConnector(() => ({
    call: () => {
      throw new McpError(-32602, 'Invalid arguments');
    },
  }));
  const o = new OfficialMcp({ connect });
  await assert.rejects(o.callTool('get_scene', {}), McpError);
  assert.equal(log.connects, 1);
});

test('gives up after one reconnect', async () => {
  const { connect, log } = fakeConnector(() => ({
    call: () => {
      throw Error('fetch failed');
    },
  }));
  const o = new OfficialMcp({ connect });
  await assert.rejects(o.callTool('get_scene', {}), /fetch failed/);
  assert.equal(log.connects, 2);
});

test('lists cached tools when unreachable and signals when the tool list changes', async () => {
  let up = false;
  let changes = 0;
  const { connect } = fakeConnector(() => (up ? { tools: [{ name: 'get_scene' }, { name: 'save_project' }], call: () => ({}) } : { refuse: true }));
  const o = new OfficialMcp({ connect, onToolsChanged: () => (changes += 1) });
  assert.deepEqual(await o.listTools(), []);
  assert.equal(o.status().connected, false);
  assert.match(o.status().last_error, /ECONNREFUSED/);
  up = true;
  assert.deepEqual((await o.listTools()).map((t) => t.name), ['get_scene', 'save_project']);
  assert.equal(changes, 1);
  o.reset();
  await o.listTools();
  assert.equal(changes, 1);
});

test('callJson parses text results and surfaces tool errors', async () => {
  const { connect } = fakeConnector(() => ({
    call: (p) => (p.name === 'bad' ? { isError: true, content: [{ type: 'text', text: 'nope' }] } : { content: [{ type: 'text', text: '{"a":1}' }] }),
  }));
  const o = new OfficialMcp({ connect });
  assert.deepEqual(await o.callJson('good', {}), { a: 1 });
  await assert.rejects(o.callJson('bad', {}), /OFFICIAL_TOOL_ERROR\(bad\): nope/);
});
