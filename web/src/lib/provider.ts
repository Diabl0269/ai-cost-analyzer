import type { To } from 'react-router';

export type Provider = 'claude' | 'codex';
export function readProvider(search: string): Provider | undefined {
  const value = new URLSearchParams(search).get('provider');
  return value === 'claude' || value === 'codex' ? value : undefined;
}
export function providerLabel(provider?: Provider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

/** Carry the global provider across navigation without copying page-local filters. */
export function withProvider(to: To, currentSearch: string): To {
  const provider = readProvider(currentSearch);
  if (!provider) return to;
  // External links do not belong to the app's filter state.
  if (typeof to === 'string' && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(to)) return to;
  const target = typeof to === 'string' ? to : `${to.pathname ?? ''}${to.search ?? ''}${to.hash ?? ''}`;
  const hashAt = target.indexOf('#');
  const hash = hashAt < 0 ? '' : target.slice(hashAt);
  const beforeHash = hashAt < 0 ? target : target.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : beforeHash.slice(queryAt + 1));
  if (!params.has('provider')) params.set('provider', provider);
  const search = `?${params.toString()}`;
  return typeof to === 'string' ? `${pathname}${search}${hash}` : { ...to, search };
}
