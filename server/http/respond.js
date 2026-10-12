import zlib from 'node:zlib';
import { HttpError, badRequest, tooLarge } from '../lib/errors.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

export function pickEncoding(req) {
  const accept = req.headers['accept-encoding'] || '';
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

export function compress(buffer, encoding, { level = 'fast' } = {}) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level === 'best' ? 11 : 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length }
    });
  }
  if (encoding === 'gzip') return zlib.gzipSync(buffer, { level: level === 'best' ? 9 : 6 });
  return buffer;
}

export function send(req, res, status, body, headers = {}) {
  let buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out = { ...SECURITY_HEADERS, ...headers };
  const encoding = buffer.length > 1024 && !out['Content-Encoding'] ? pickEncoding(req) : null;
  if (encoding) {
    buffer = compress(buffer, encoding);
    out['Content-Encoding'] = encoding;
    out.Vary = 'Accept-Encoding';
  }
  out['Content-Length'] = buffer.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

export function sendJSON(req, res, status, data, headers = {}) {
  send(req, res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

export function sendError(req, res, err, log) {
  if (err instanceof HttpError) {
    sendJSON(req, res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  log.error(`${req.method} ${req.url} failed:`, err.stack || err.message);
  sendJSON(req, res, 500, { error: "Something went wrong on the server. Try again, and if it keeps happening, check the server's log." });
}

// Read a request body into a Buffer, refusing anything over `limit` bytes. An oversized body is
// read to the end (up to a point) before refusing, otherwise clients that close the connection
// after each request never see the "too large" reply.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const drainCap = limit * 4 + 1024 * 1024;
    const declared = Number(req.headers['content-length']);
    if (declared > drainCap) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let over = declared > limit;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { if (over) finish(reject, tooLarge()); }, 10000);
    timer.unref?.();
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) over = true;
      if (size > drainCap) { finish(reject, tooLarge()); return; }
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => (over ? finish(reject, tooLarge()) : finish(resolve, Buffer.concat(chunks))));
    req.on('error', err => finish(reject, err));
  });
}

export async function readJSON(req, limit) {
  const buffer = await readBody(req, limit);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw badRequest('The request body is not valid JSON');
  }
}
