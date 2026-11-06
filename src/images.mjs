// Fetching / reading images for tool results; only real png / jpeg / gif / webp bytes are returned.
import fs from 'node:fs';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function toImage(buf, origin) {
  if (buf.length > MAX_IMAGE_BYTES) throw Error(`image too large: ${buf.length} bytes`);
  const mimeType = sniffImage(buf);
  if (!mimeType) throw Error(`not a png/jpeg/gif/webp image (${origin})`);
  return { data: buf.toString('base64'), mimeType };
}

export async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  return toImage(Buffer.from(await res.arrayBuffer()), `content-type ${res.headers.get('content-type')}`);
}

export async function readImageFile(file) {
  return toImage(await fs.promises.readFile(file), file);
}
