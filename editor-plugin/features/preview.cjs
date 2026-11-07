'use strict';
// Preview frames at the preview's own resolution, read from the render output. Since 9.8.1 the
// official screenshot photographs the editor window's preview area instead, which comes back black
// while the window is minimized; the render output keeps updating either way.
const { M } = require('./common.cjs');

// Right after a window opens the preview has no frame yet and the capture comes back empty (seen
// live once, fine 4 s later). Picked, not measured: 20 tries 100 ms apart cover the preview starting up.
const EMPTY_RETRIES = 20;
const RETRY_MS = 100;

// Measured on 9.8.1 (two runs, window in front and in the background): after PreviewReloaded the
// first new frame still shows the bare video without the effect; the second one is right.
const FRESH_FRAMES = 2;
// Picked, not measured: a reload took about 0.7 s and the first frames after it 0.4 s; these leave
// room for heavy effects and the 6 fps background mode. The MCP server's RESET_TIMEOUT_MS is their sum.
const TIMING = { reloadTimeoutMs: 15000, frameTimeoutMs: 5000 };

const RELOADED = 'PreviewReloaded';
const TEXTURE = 'PreviewTextureUpdated';

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

  // Reloads the preview like the official reset_preview and returns once it shows the reloaded
  // effect. The official call returns at PreviewReloaded, when the render output still holds frames
  // from before the reset.
  async previewReset() {
    this.ensureCompatible('previewReset');
    const { reloadTimeoutMs, frameTimeoutMs } = { ...TIMING, ...this.previewTiming };
    const { PreviewSyncer } = this.mod(M.ef);
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const started = Date.now();
    let onReloaded;
    let onTexture;
    let timer;
    let reloadedAt = null;
    let frames = 0;
    try {
      await new Promise((resolve, reject) => {
        const fail = (code, ms, what) => {
          timer = setTimeout(() => reject(Error(`${code}: ${what} within ${ms} ms`)), ms);
        };
        onReloaded = () => {
          if (reloadedAt !== null) return;
          reloadedAt = Date.now();
          clearTimeout(timer);
          fail('NO_FRESH_PREVIEW_FRAME', frameTimeoutMs, `the preview did not draw ${FRESH_FRAMES} frames after reloading`);
        };
        onTexture = () => {
          if (reloadedAt === null) return;
          frames += 1;
          if (frames >= FRESH_FRAMES) resolve();
        };
        PreviewSyncer.addListener(RELOADED, onReloaded);
        bus.on(TEXTURE, onTexture);
        fail('PREVIEW_RELOAD_TIMEOUT', reloadTimeoutMs, 'the preview did not reload');
        PreviewSyncer.getInstance().requestReloadSticker();
      });
    } finally {
      clearTimeout(timer);
      PreviewSyncer.removeListener(RELOADED, onReloaded);
      bus.off(TEXTURE, onTexture);
    }
    return { reloaded_ms: reloadedAt - started, ready_ms: Date.now() - started };
  },

  // While the window is in the background the editor draws at 6 fps. Recording mode is how the
  // editor keeps full rate while recording in the background; holding it for `hold_ms` (renewed by
  // each call, released by hold_ms 0 or when it runs out) keeps frames from repeating. A recording
  // the user started is left alone.
  previewFullRate({ hold_ms }) {
    this.ensureCompatible('previewFullRate');
    if (!Number.isInteger(hold_ms) || hold_ms < 0) throw Error(`INVALID_HOLD_MS: ${hold_ms}`);
    const pm = this.mod(M.preview).PreviewManager.getInstance();
    const bg = this.mod(M.backgroundMode).BackgroundModeManager.getInstance();
    const release = () => {
      clearTimeout(this.fullRateTimer);
      this.fullRateTimer = null;
      if (!pm.isRecording()) bg.setRecordingMode(false);
    };
    if (hold_ms === 0) {
      if (this.fullRateTimer) release();
      return { held: false };
    }
    if (!this.fullRateTimer && pm.isRecording()) return { held: false, reason: 'recording' };
    clearTimeout(this.fullRateTimer);
    bg.setRecordingMode(true);
    this.fullRateTimer = setTimeout(release, hold_ms);
    return { held: true };
  },

  // The window the official screenshot photographs; it shows nothing while minimized or hidden.
  previewWindow() {
    this.ensureCompatible('previewWindow');
    const { WindowState } = this.mod(M.orionui);
    const win = this.mod(M.editWindow).EditWindowController.getInstance().getWindow();
    if (!win) return { visible: false, minimized: false, window: false };
    const minimized = win.windowState === WindowState.Minimized;
    return { visible: !!win.visible && !minimized, minimized, window: true };
  },
};

const METHODS = { preview_frame: 'previewFrame', preview_reset: 'previewReset', preview_full_rate: 'previewFullRate', preview_window: 'previewWindow' };

module.exports = { methods, METHODS };
