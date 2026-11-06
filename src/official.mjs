// Client for 像塑's official MCP (streamable HTTP). Connects lazily, reconnects after the editor restarts,
// and reports when the official tool list changes so the proxy can notify its own clients.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export const OFFICIAL_URL = process.env.XIANGSU_MCP_URL ?? 'http://127.0.0.1:17320/mcp';
// Generation tools (images, audio, workflows) can run for minutes.
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

async function defaultConnect(url) {
  const client = new Client({ name: 'xiangsu-mcp-ext', version: '0.2.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

export class OfficialMcp {
  constructor({ url = OFFICIAL_URL, connect = defaultConnect, onToolsChanged } = {}) {
    this.url = url;
    this.connectFn = connect;
    this.onToolsChanged = onToolsChanged;
    this.client = null;
    this.connecting = null;
    this.tools = [];
    this.lastError = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const client = await this.connectFn(this.url);
          const { tools } = await client.listTools();
          const changed = JSON.stringify(tools.map((t) => t.name)) !== JSON.stringify(this.tools.map((t) => t.name));
          this.client = client;
          this.tools = tools;
          this.lastError = null;
          if (changed && this.onToolsChanged) this.onToolsChanged();
          return client;
        } catch (e) {
          this.lastError = String(e?.message ?? e);
          throw e;
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  reset() {
    const c = this.client;
    this.client = null;
    if (c) c.close().catch(() => {});
  }

  status() {
    return { url: this.url, connected: !!this.client, tools: this.tools.length, last_error: this.lastError };
  }

  // Cached official tools; an unreachable editor yields the last known list (empty before first contact).
  async listTools() {
    try {
      await this.connect();
    } catch (_) {}
    return this.tools;
  }

  // Protocol-level errors (bad arguments, unknown tool) are the official server's answer and are not
  // retried; transport failures (editor restarted, session expired) reconnect once and retry.
  async callTool(name, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        return await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
      } catch (e) {
        if (e instanceof McpError || attempt >= 1) throw e;
        this.reset();
      }
    }
  }

  async callJson(name, args) {
    const res = await this.callTool(name, args);
    const text = (res.content || []).find((c) => c.type === 'text')?.text;
    if (res.isError) throw Error(`OFFICIAL_TOOL_ERROR(${name}): ${text ?? 'unknown error'}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw Error(`OFFICIAL_TOOL_BAD_RESPONSE(${name}): ${String(text).slice(0, 200)}`);
    }
  }

  // Keeps trying to connect while disconnected so tools appear once 像塑 starts.
  watch(intervalMs = 5000) {
    const timer = setInterval(() => {
      if (!this.client) this.connect().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return timer;
  }
}
