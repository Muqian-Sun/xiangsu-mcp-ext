'use strict';
// Dev-only escape hatch for probing editor internals. The flag is read on every call, so turning
// devEval off in config.local.json disables it immediately without reopening editor windows.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.local.json');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Also gates the runtime's eval and describe methods.
function devEvalEnabled() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).devEval === true;
  } catch (_) {
    return false;
  }
}

const methods = {
  async devEval({ code }) {
    if (!devEvalEnabled()) throw Error('EVAL_DISABLED');
    if (typeof code !== 'string' || !code) throw Error('code must be a non-empty string');
    const value = await new AsyncFunction('mod', 'require', code)(this.mod, require);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  },
};

const METHODS = { dev_eval: 'devEval' };

module.exports = { methods, METHODS, CONFIG_PATH, devEvalEnabled };
