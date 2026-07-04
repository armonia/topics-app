import { describe, it, expect, afterEach } from 'bun:test';
import { resolveBrowserNavigateUrl } from './browserNavUrl';

// Stub the parts of `window` the resolver reads. Each case sets its own.
function setWindow(opts: {
  hostname: string;
  protocol?: string;
}) {
  (globalThis as { window?: unknown }).window = {
    location: { hostname: opts.hostname, protocol: opts.protocol ?? 'https:' },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('resolveBrowserNavigateUrl', () => {
  it('does not rewrite localhost when the client host is itself local (127.0.0.1)', () => {
    // The white-screen guard: an agent opens a freshly started http dev server.
    // On a host that can reach localhost directly this must stay http://localhost —
    // forcing https made it an unreachable URL → chrome-error blank page.
    setWindow({ hostname: '127.0.0.1', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(resolveBrowserNavigateUrl('http://127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
  });

  it('does not rewrite when the web client is itself local', () => {
    setWindow({ hostname: 'localhost', protocol: 'http:' });
    expect(resolveBrowserNavigateUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
  });

  it('rewrites localhost for a remote web client (Tailscale/LAN)', () => {
    setWindow({ hostname: '100.64.0.5', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('http://localhost:3000/x')).toBe('https://100.64.0.5:3000/x');
  });

  it('leaves non-local URLs untouched in every mode', () => {
    setWindow({ hostname: '100.64.0.5', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('https://example.com/page')).toBe('https://example.com/page');
    setWindow({ hostname: '127.0.0.1' });
    expect(resolveBrowserNavigateUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('returns non-URL strings unchanged', () => {
    setWindow({ hostname: '100.64.0.5' });
    expect(resolveBrowserNavigateUrl('about:blank')).toBe('about:blank');
    expect(resolveBrowserNavigateUrl('not a url')).toBe('not a url');
  });
});
