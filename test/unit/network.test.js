import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isLocalNetwork } from '../../server/http/network.js';
import { clientAddress } from '../../server/services/auth.js';

describe('network: private and local addresses', () => {
  it('knows home, VPN and loopback addresses from the internet', () => {
    for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '172.20.3.4', '192.168.1.20', '::ffff:192.168.1.20', '100.101.102.103', 'fd12:3456::1', 'fe80::1%eth0', '169.254.1.1']) {
      assert.ok(isPrivateAddress(ip), ip);
      assert.ok(isLocalNetwork(ip), ip);
    }
    for (const ip of ['8.8.8.8', '203.0.113.9', '::ffff:8.8.8.8', '2606:4700::1111', '', 'nonsense', undefined]) {
      assert.equal(isPrivateAddress(ip), false, String(ip));
    }
  });
});

describe('sign-in: who is guessing', () => {
  const req = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

  it('only believes X-Forwarded-For from a proxy on a private network, and only when told to', () => {
    assert.equal(clientAddress(req('10.0.0.5', 'made-up, 81.2.69.160'), true), '81.2.69.160', 'the last address, which the proxy added');
    assert.equal(clientAddress(req('203.0.113.9', '81.2.69.160'), true), '203.0.113.9', 'straight from the internet: the header could say anything');
    assert.equal(clientAddress(req('10.0.0.5', '81.2.69.160'), false), '10.0.0.5', 'without BRISK_TRUST_PROXY');
  });
});
