// Account and group icons used to be stored inline as base64 inside accounts.json, which made
// every page load download them all. They now live as image files the browser can cache.
import crypto from 'node:crypto';

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function decodeDataUrl(value) {
  if (typeof value !== 'string') return null;
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!m || !MIME_EXT[m[1]]) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return null;
  return { buffer, ext: MIME_EXT[m[1]] };
}

export const iconHash = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);

export default {
  version: 3,
  name: 'Move icons into image files',
  up(data) {
    const move = (item, kind) => {
      const current = item.icon;
      if (current && typeof current === 'object' && typeof current.file === 'string' && data.icons[current.file]) return; // already a file
      const decoded = decodeDataUrl(current);
      if (decoded) {
        const file = `${kind}-${item.id}.${decoded.ext}`;
        data.icons[file] = decoded.buffer;
        item.icon = { file, hash: iconHash(decoded.buffer) };
      } else {
        item.icon = null;
      }
    };
    for (const account of data.accounts) move(account, 'account');
    for (const group of data.groups) move(group, 'group');
  }
};
