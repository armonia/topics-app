import { describe, it, expect } from 'bun:test';
import { isFramable, type HeaderGetter } from './browser-framing';

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
