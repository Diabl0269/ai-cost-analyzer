import { describe, expect, it } from 'vitest';
import { readProvider, withProvider } from '../../web/src/lib/provider.js';

describe('global provider navigation', () => {
  it('accepts only the two supported providers, with absence meaning all', () => {
    expect(readProvider('')).toBeUndefined();
    expect(readProvider('?provider=unknown')).toBeUndefined();
    expect(readProvider('?provider=codex')).toBe('codex');
    expect(readProvider('?provider=claude')).toBe('claude');
  });
  it('retains provider across search, transcript jumps and document anchors', () => {
    expect(withProvider('/search?q=cache', '?provider=codex&project=alpha')).toBe('/search?q=cache&provider=codex&project=alpha');
    expect(withProvider('/sessions/id/transcript?seq=9', '?provider=codex')).toBe('/sessions/id/transcript?seq=9&provider=codex');
    expect(withProvider('/settings#data', '?provider=claude')).toBe('/settings?provider=claude#data');
    expect(withProvider({ pathname: '/sessions', search: '?q=cache', hash: '#list' }, '?provider=codex'))
      .toEqual({ pathname: '/sessions', search: '?q=cache&provider=codex', hash: '#list' });
  });
  it('keeps explicit provider targets, unfiltered links and external URLs intact', () => {
    expect(withProvider('/sessions?provider=claude', '?provider=codex')).toBe('/sessions?provider=claude');
    expect(withProvider('/sessions', '')).toBe('/sessions');
    expect(withProvider('https://example.com/', '?provider=codex')).toBe('https://example.com/');
  });
  it('carries history and project filters between data pages without copying page-local filters', () => {
    const current = '?from=2000-01-01&to=2026-11-05&project=alpha&q=cache&cursor=old';
    const sessions = withProvider('/sessions', current) as string;
    expect(sessions).toBe('/sessions?from=2000-01-01&to=2026-11-05&project=alpha');
    expect(withProvider('/', sessions.slice(sessions.indexOf('?')))).toBe('/?from=2000-01-01&to=2026-11-05&project=alpha');
    expect(withProvider('/sessions?project=beta', current)).toBe('/sessions?project=beta&from=2000-01-01&to=2026-11-05');
    expect(withProvider('/sessions?project=', current)).toBe('/sessions?project=&from=2000-01-01&to=2026-11-05');
    expect(withProvider('/settings#data', current)).toBe('/settings#data');
    expect(withProvider('/methodology', current)).toBe('/methodology');
    expect(withProvider('#turns', current)).toBe('?from=2000-01-01&to=2026-11-05&project=alpha#turns');
  });

});
