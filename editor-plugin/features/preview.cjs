'use strict';
// Preview frames at the preview's own resolution. The official screenshot goes through the same
// PreviewManager calls and then shrinks the frame to 320×569; this returns it before that step.
const { M } = require('./common.cjs');

// Right after a window opens the preview has no frame yet and the capture comes back empty (seen
// live once, fine 4 s later). Picked, not measured: 20 tries 100 ms apart cover the preview starting up.
const EMPTY_RETRIES = 20;
const RETRY_MS = 100;

const methods = {
  async previewFrame({ quality = 92 } = {}) {
    this.ensureCompatible('preview');
    const pm = this.mod(M.preview).PreviewManager.getInstance();
    for (let i = 0; i < EMPTY_RETRIES; i++) {
      if (i) await new Promise((r) => setTimeout(r, RETRY_MS));
      pm.cacheCurrentFrame();
      const buf = pm.captureScreenshotToMemory(quality);
      if (buf && buf.length) return { mimeType: 'image/jpeg', data: Buffer.from(buf).toString('base64') };
    }
    throw Error(`NO_PREVIEW_FRAME: the preview returned no frame after ${EMPTY_RETRIES} tries; is the preview panel showing?`);
  },
};

const METHODS = { preview_frame: 'previewFrame' };

module.exports = { methods, METHODS };
