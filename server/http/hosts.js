// Which addresses Brisk Budget answers to when no password is set.
//
// A website can point a name it owns at the address of a server on your network ("DNS
// rebinding"), after which your browser treats Brisk Budget as part of that website and lets it
// read and change your data. Names like that can be bought on the internet; the ones below can't,
// so they're always fine. Anything else has to be listed in BRISK_ALLOWED_HOSTS. With a password
// set this doesn't matter: the sign-in cookie never goes to someone else's name.
import os from 'node:os';
import net from 'node:net';

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet', '.private', '.corp', '.fritz.box', '.ts.net'];

// "budget.example.com, *.home.example.com" -> matchers
function parseList(text) {
  return String(text || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

export function hostName(header) {
  const text = String(header || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']') > 0 ? text.indexOf(']') : undefined);
  return text.replace(/:\d*$/, '').replace(/\.$/, '');
}

export function createHostCheck({ allowedHosts = '' } = {}) {
  const extra = parseList(allowedHosts);
  const anything = extra.includes('*');
  const machine = os.hostname().toLowerCase();
  const own = new Set([machine, `${machine}.local`]);

  return function allowed(header) {
    if (anything) return true;
    const name = hostName(header);
    if (!name) return true; // very old clients send no Host at all
    if (net.isIP(name) || name === 'localhost' || !name.includes('.') || own.has(name)) return true;
    if (LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix))) return true;
    return extra.some(entry => entry.startsWith('*.') ? name.endsWith(entry.slice(1)) : name === entry);
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// A reverse proxy on the same machine (nginx, Caddy) passes on whatever name people use
export function fromLocalProxy(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  return !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded);
}

export function refusedMessage(header) {
  const name = hostName(header) || String(header);
  return `Brisk Budget didn't answer because it doesn't recognise the address "${name}". ` +
    "This stops other websites from reaching your Brisk Budget through your browser. To use this address, either set a password " +
    "(open Brisk Budget by its IP address, then Settings › Security) or add " +
    `BRISK_ALLOWED_HOSTS=${name} to its settings (/etc/default/brisk-budget if it was installed with the install command) and restart it.`;
}
