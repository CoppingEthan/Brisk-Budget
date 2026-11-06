// Whether an address is on a private or local network: this machine, a home or office network,
// a VPN like Tailscale, or a network the server itself is connected to (which keeps IPv6 home
// networks working, where devices use public-looking addresses).
import net from 'node:net';
import os from 'node:os';

const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4'); // this machine
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT, used by Tailscale
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE.addSubnet('fe80::', 10, 'ipv6'); // link-local

// The networks this server is on, refreshed now and then in case they change
let own = null;
let ownAt = 0;
function ownNetworks() {
  if (own && Date.now() - ownAt < 60 * 1000) return own;
  own = new net.BlockList();
  ownAt = Date.now();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        const [address, bits] = String(iface.cidr || '').split('/');
        if (!address || !bits) continue;
        // An IPv6 home network is a /64; anything wider would take in other people's networks
        const prefix = iface.family === 'IPv6' ? Math.max(Number(bits), 64) : Number(bits);
        own.addSubnet(address.split('%')[0], prefix, iface.family === 'IPv6' ? 'ipv6' : 'ipv4');
      }
    }
  } catch {
    // Without interface details, only the private ranges count
  }
  return own;
}

// "::ffff:192.168.1.5" (an IPv4 address on an IPv6 socket) -> "192.168.1.5"
function plain(address) {
  const text = String(address || '').split('%')[0];
  return text.startsWith('::ffff:') && net.isIPv4(text.slice(7)) ? text.slice(7) : text;
}

export function isPrivateAddress(address) {
  const ip = plain(address);
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return !!family && PRIVATE.check(ip, family);
}

export function isLocalNetwork(address) {
  const ip = plain(address);
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!family) return false;
  return PRIVATE.check(ip, family) || ownNetworks().check(ip, family);
}
