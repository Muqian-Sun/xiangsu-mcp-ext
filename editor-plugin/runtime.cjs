'use strict';
// Runs inside a 像塑 project window. Serves a token-protected RPC endpoint on 127.0.0.1
// and advertises it through a per-process state file read by the MCP server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const STATE_ROOT = path.join(os.homedir(), '.xiangsu-mcp-ext');
const INSTANCE_DIR = path.join(STATE_ROOT, 'instances');
const LOG_FILE = path.join(STATE_ROOT, 'logs', 'plugin.log');
const MAX_BODY = 4 * 1024 * 1024;

function log(...args) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${process.pid}] ${args.map(String).join(' ')}\n`);
  } catch (_) {}
}

function orion() {
  return globalThis.orion;
}

function requireModule(name) {
  const registry = orion();
  if (!registry) throw Error('globalThis.orion is unavailable');
  const mod = registry[name];
  if (mod === undefined) throw Error(`MODULE_NOT_FOUND: ${name}`);
  return mod;
}

function currentProject() {
  try {
    return requireModule('@orion/orion-sdk/EditorFramework').Project.getCurrent() || null;
  } catch (_) {
    return null;
  }
}

function ownKeys(v) {
  const keys = new Set();
  let o = v;
  for (let i = 0; o && o !== Object.prototype && o !== Function.prototype && i < 4; i++) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') keys.add(k);
    o = Object.getPrototypeOf(o);
  }
  return [...keys];
}

// JSON-safe snapshot with depth / size limits; getters that throw are reported, not propagated.
function snapshot(value, depth = 2, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string') return value.length > 2000 ? value.slice(0, 2000) + `…(${value.length})` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'symbol') return value.toString();
  if (t === 'function') {
    const out = { $fn: value.name || '(anonymous)', length: value.length };
    const statics = Object.getOwnPropertyNames(value).filter((k) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(k));
    if (statics.length) out.statics = statics.slice(0, 200);
    if (value.prototype) {
      const proto = ownKeys(value.prototype);
      if (proto.length) out.proto = proto.slice(0, 200);
    }
    return out;
  }
  if (seen.has(value)) return '$cycle';
  seen.add(value);
  if (Array.isArray(value)) {
    if (depth <= 0) return { $array: value.length };
    return value.slice(0, 100).map((v) => snapshot(v, depth - 1, seen));
  }
  if (value instanceof Map) {
    if (depth <= 0) return { $map: value.size };
    return { $map: [...value.entries()].slice(0, 100).map(([k, v]) => [snapshot(k, 0, seen), snapshot(v, depth - 1, seen)]) };
  }
  if (Buffer.isBuffer(value)) return { $buffer: value.length };
  const ctor = value.constructor && value.constructor.name;
  if (depth <= 0) return { $object: ctor || 'Object', keys: ownKeys(value).slice(0, 50) };
  const out = ctor && ctor !== 'Object' ? { $class: ctor } : {};
  for (const k of ownKeys(value).slice(0, 200)) {
    let v;
    try {
      v = value[k];
    } catch (e) {
      out[k] = { $throws: String(e) };
      continue;
    }
    out[k] = snapshot(v, typeof v === 'function' ? 0 : depth - 1, seen);
  }
  return out;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class Runtime {
  constructor(config) {
    this.config = config || {};
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.stateFile = path.join(INSTANCE_DIR, `${process.pid}.json`);
    this.methods = {
      status: () => this.status(),
      describe: ({ module, depth = 1 }) => snapshot(requireModule(module), depth),
      eval: ({ code, depth = 2 }) => this.evaluate(code, depth),
    };
  }

  status() {
    const p = currentProject();
    return {
      pid: process.pid,
      projectPath: p?.path || null,
      hasOrion: !!orion(),
      devEval: !!this.config.devEval,
      methods: Object.keys(this.methods),
    };
  }

  async evaluate(code, depth) {
    if (!this.config.devEval) throw Error('EVAL_DISABLED');
    if (typeof code !== 'string' || !code) throw Error('code must be a non-empty string');
    const fn = new AsyncFunction('orion', 'mod', 'require', 'log', code);
    const result = await fn(orion(), requireModule, require, log);
    return snapshot(result, depth);
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(0, '127.0.0.1', () => {
      const { port } = this.server.address();
      fs.mkdirSync(INSTANCE_DIR, { recursive: true, mode: 0o700 });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token: this.token, startedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
      log('listening', port);
    });
    this.server.on('error', (e) => log('server error', e && e.stack));
  }

  stop() {
    try {
      this.server && this.server.close();
    } catch (_) {}
    try {
      fs.unlinkSync(this.stateFile);
    } catch (_) {}
  }

  handle(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { ok: false, error: 'not found' });
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${this.token}`;
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return send(401, { ok: false, error: 'unauthorized' });
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(400, { ok: false, error: 'invalid json' });
      }
      const fn = this.methods[body.method];
      if (!fn) return send(400, { ok: false, error: `unknown method: ${body.method}` });
      try {
        const value = await fn(body.params || {});
        send(200, { ok: true, value });
      } catch (e) {
        log('rpc error', body.method, e && e.stack);
        send(200, { ok: false, error: String((e && e.message) || e) });
      }
    });
  }
}

module.exports = { Runtime, snapshot, log };
