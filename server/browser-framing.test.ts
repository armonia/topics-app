/**
 * Can a third-party origin frame this response? It is the decision behind the
 * web pane's iframe-vs-stream choice and behind the `framable` probe.
 * @covers BROWSER-CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { isFramable, isPrivateIpv4, isPrivateIpv6, isSafePublicUrl, type HeaderGetter } from './browser-framing';

// Pure decision: can a third-party origin (us) frame this response? Conservative
// — any restriction to specific origins counts as NOT framable, because we're
// almost never on such an allowlist. Drives the web pane's iframe-vs-stream choice.

const h = (map: Record<string, string>): HeaderGetter => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

describe('isFramable', () => {
  it('no framing headers → framable', () => {
    expect(isFramable(h({}))).toBe(true);
    expect(isFramable(h({ 'content-security-policy': "default-src 'self'; script-src 'self'" }))).toBe(true);
  });

  it('X-Frame-Options DENY / SAMEORIGIN / ALLOW-FROM → not framable', () => {
    expect(isFramable(h({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(isFramable(h({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
    expect(isFramable(h({ 'x-frame-options': 'sameorigin' }))).toBe(false);
    expect(isFramable(h({ 'x-frame-options': 'ALLOW-FROM https://x.com' }))).toBe(false);
  });

  it("CSP frame-ancestors 'none' / specific origin → not framable", () => {
    expect(isFramable(h({ 'content-security-policy': "frame-ancestors 'none'" }))).toBe(false);
    expect(isFramable(h({ 'content-security-policy': "frame-ancestors 'self'" }))).toBe(false);
    expect(isFramable(h({ 'content-security-policy': "default-src 'self'; frame-ancestors https://trusted.com" }))).toBe(false);
  });

  it('CSP frame-ancestors * → framable', () => {
    expect(isFramable(h({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true);
    expect(isFramable(h({ 'content-security-policy': "default-src 'self'; frame-ancestors https://*.x.com *" }))).toBe(true);
  });

  it('CSP without a frame-ancestors directive → framable', () => {
    expect(isFramable(h({ 'content-security-policy': "default-src 'self'; img-src *" }))).toBe(true);
  });

  it('XFO takes precedence — blocked even if CSP would allow', () => {
    expect(isFramable(h({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' }))).toBe(false);
  });
});

describe('SSRF guard', () => {
  it('flags private / loopback / link-local / CGNAT / metadata IPv4', () => {
    for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1']) {
      expect(isPrivateIpv4(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1']) {
      expect(isPrivateIpv4(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local / v4-mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect(isPrivateIpv6(ip)).toBe(true);
    }
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
  });

  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  const internal = async () => [{ address: '10.0.0.5', family: 4 }];

  it('rejects non-http, internal names, and IP literals in private ranges', async () => {
    expect(await isSafePublicUrl('ftp://example.com', pub)).toBe(false);
    expect(await isSafePublicUrl('file:///etc/passwd', pub)).toBe(false);
    expect(await isSafePublicUrl('https://localhost/', pub)).toBe(false);
    expect(await isSafePublicUrl('https://foo.internal/', pub)).toBe(false);
    expect(await isSafePublicUrl('http://169.254.169.254/latest/meta-data/', pub)).toBe(false);
    expect(await isSafePublicUrl('http://10.0.0.5/', pub)).toBe(false);
    expect(await isSafePublicUrl('http://[::1]/', pub)).toBe(false);
  });

  it('allows a public host and blocks a public NAME that resolves internal (rebinding)', async () => {
    expect(await isSafePublicUrl('https://example.com/', pub)).toBe(true);
    expect(await isSafePublicUrl('https://evil.example/', internal)).toBe(false);
  });

  it('DNS failure → unsafe', async () => {
    const fail = async () => { throw new Error('ENOTFOUND'); };
    expect(await isSafePublicUrl('https://nope.example/', fail)).toBe(false);
  });
});
