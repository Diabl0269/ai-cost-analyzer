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
    expect(withProvider('/search?q=cache', '?provider=codex&project=alpha')).toBe('/search?q=cache&provider=codex');
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
});
