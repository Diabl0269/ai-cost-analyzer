/**
 * Typed client for every endpoint in SPEC §7.2.
 * One fetch wrapper: same-origin credentials, JSON in/out, `ApiError` with a code, an
 * up-front session bootstrap, and a single retry on a 401 as the fallback (SPEC §7.3).
 */
import { useEffect, useRef, useState } from 'react';
import type {
  AgentTreeResponse,
  AttributionAnalyticsResponse,
  HooksAnalyticsResponse,
  IndexEvent,
  InsightsResponse,
  ModelsAnalyticsResponse,
  OverviewResponse,
  PricingConfig,
  ProjectsResponse,
  RangeQuery,
  SearchQuery,
  SearchResponse,
  SessionDetail,
  SessionExport,
  SessionsQuery,
  SessionsResponse,
  StatusResponse,
  ToolsAnalyticsResponse,
  TranscriptPage,
  UserSettings,
} from '@core/types';

export const API_BASE = '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** True when the failure is worth retrying automatically. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export type QueryValue = string | number | boolean | string[] | undefined | null;

export function toSearchParams(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

interface RequestInitLite {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

let bootstrap: Promise<void> | null = null;

/** POST /api/auth/session — issues the HttpOnly cookie the other routes require. */
export function ensureSession(): Promise<void> {
  bootstrap ??= fetch(`${API_BASE}/auth/session`, { method: 'POST', credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new ApiError('Could not start a local session', 'auth_bootstrap_failed', response.status);
    })
    .catch((error: unknown) => {
      bootstrap = null;
      throw asApiError(error);
    });
  return bootstrap;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError('Request cancelled', 'aborted', 0);
  }
  const message = error instanceof Error ? error.message : 'Network request failed';
  return new ApiError(message, 'network', 0);
}

async function toError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || 'Request failed';
  try {
    // JSON.parse boundary: narrow immediately, never trust the shape.
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const detail = (payload as { error: unknown }).error;
      if (detail && typeof detail === 'object') {
        const { code: rawCode, message: rawMessage } = detail as { code?: unknown; message?: unknown };
        if (typeof rawCode === 'string') code = rawCode;
        if (typeof rawMessage === 'string') message = rawMessage;
      }
    }
  } catch {
    /* non-JSON error body: keep the status-derived message */
  }
  return new ApiError(message, code, response.status);
}

async function send(path: string, init: RequestInitLite): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const request: RequestInit = {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    cache: 'no-store',
  };
  if (body !== undefined) request.body = body;
  if (init.signal) request.signal = init.signal;
  return fetch(`${API_BASE}${path}${toSearchParams(init.query)}`, request);
}

async function apiFetch<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  let response: Response;
  try {
    // Bootstrap *before* the first call rather than paying a 401 round trip for every request
    // in flight on a cold load. `ensureSession` memoises its promise, so this is one POST per
    // page load; a failure here is not fatal, the 401 retry below is still the fallback.
    await ensureSession().catch(() => undefined);
    response = await send(path, init);
    if (response.status === 401) {
      bootstrap = null;
      await ensureSession();
      response = await send(path, init);
    }
  } catch (error) {
    throw asApiError(error);
  }
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    // JSON.parse boundary: the server contract is `core/types.ts`.
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('The server returned a response that is not JSON', 'bad_json', response.status);
  }
}

const range = (query: RangeQuery | undefined): Record<string, QueryValue> => ({
  from: query?.from,
  to: query?.to,
  project: query?.project,
  provider: query?.provider,
  whatIf: query?.whatIf,
});

export const api = {
  status: (signal?: AbortSignal) => apiFetch<StatusResponse>('/status', { signal }),

  projects: (query?: RangeQuery, signal?: AbortSignal) =>
    apiFetch<ProjectsResponse>('/projects', { query: range(query), signal }),

  sessions: (query: SessionsQuery, signal?: AbortSignal) =>
    apiFetch<SessionsResponse>('/sessions', {
      query: {
        ...range(query),
        q: query.q,
        sort: query.sort,
        order: query.order,
        limit: query.limit,
        cursor: query.cursor,
        model: query.model,
        entrypoint: query.entrypoint,
        pinned: query.pinned,
        hasAgents: query.hasAgents,
      },
      signal,
    }),

  session: (sessionId: string, query?: RangeQuery, signal?: AbortSignal) =>
    apiFetch<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`, { query: { whatIf: query?.whatIf }, signal }),

  transcript: (
    sessionId: string,
    options: { agentId?: string | null; fromSeq?: number; limit?: number; whatIf?: string } = {},
    signal?: AbortSignal,
  ) =>
    apiFetch<TranscriptPage>(`/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      query: {
        agentId: options.agentId ?? undefined,
        fromSeq: options.fromSeq,
        limit: options.limit,
        whatIf: options.whatIf,
      },
      signal,
    }),

  agents: (sessionId: string, query?: RangeQuery, signal?: AbortSignal) =>
    apiFetch<AgentTreeResponse>(`/sessions/${encodeURIComponent(sessionId)}/agents`, {
      query: { whatIf: query?.whatIf },
      signal,
    }),

  search: (query: SearchQuery, signal?: AbortSignal) =>
    apiFetch<SearchResponse>('/search', {
      query: {
        ...range(query),
        q: query.q,
        scope: query.scope,
        kinds: query.kinds,
        model: query.model,
        tool: query.tool,
        limit: query.limit,
        cursor: query.cursor,
      },
      signal,
    }),

  overview: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<OverviewResponse>('/analytics/overview', { query: range(query), signal }),

  toolsAnalytics: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<ToolsAnalyticsResponse>('/analytics/tools', { query: range(query), signal }),

  modelsAnalytics: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<ModelsAnalyticsResponse>('/analytics/models', { query: range(query), signal }),

  hooksAnalytics: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<HooksAnalyticsResponse>('/analytics/hooks', { query: range(query), signal }),

  attributionAnalytics: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<AttributionAnalyticsResponse>('/analytics/attribution', { query: range(query), signal }),

  insights: (query: RangeQuery, signal?: AbortSignal) =>
    apiFetch<InsightsResponse>('/analytics/insights', { query: range(query), signal }),

  pricing: (signal?: AbortSignal) => apiFetch<PricingConfig>('/pricing', { signal }),

  updatePricing: (config: PricingConfig) => apiFetch<PricingConfig>('/pricing', { method: 'PUT', body: config }),

  resetPricing: () => apiFetch<PricingConfig>('/pricing/reset', { method: 'POST' }),

  settings: (signal?: AbortSignal) => apiFetch<UserSettings>('/settings', { signal }),

  updateSettings: (settings: UserSettings) => apiFetch<UserSettings>('/settings', { method: 'PUT', body: settings }),

  /**
   * Toggles the pin and returns the resulting state. The server owns the flip
   * (`ConfigStore.togglePin`), so there is nothing to send in the body.
   */
  pinSession: (sessionId: string) =>
    apiFetch<{ pinned: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/pin`, { method: 'POST' }),

  reindex: (full = false) => apiFetch<{ started: true }>('/reindex', { method: 'POST', body: { full } }),

  exportSession: (sessionId: string) =>
    apiFetch<SessionExport>(`/export/sessions/${encodeURIComponent(sessionId)}.json`),

  /**
   * Href for the CSV download (a plain link, so the browser handles the file).
   * Every filter the list view applies is forwarded; `limit`/`cursor` are not — the export
   * covers the whole match set, not one page.
   */
  sessionsCsvHref: (query: SessionsQuery): string =>
    `${API_BASE}/export/sessions.csv${toSearchParams({
      ...range(query),
      q: query.q,
      sort: query.sort,
      order: query.order,
      model: query.model,
      entrypoint: query.entrypoint,
      pinned: query.pinned,
      hasAgents: query.hasAgents,
    })}`,

  sessionJsonHref: (sessionId: string): string => `${API_BASE}/export/sessions/${encodeURIComponent(sessionId)}.json`,
};

export type IndexEventHandler = (event: IndexEvent) => void;

function parseIndexEvent(raw: string): IndexEvent | null {
  try {
    // JSON.parse boundary.
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
      return value as IndexEvent;
    }
  } catch {
    /* ignore malformed frames */
  }
  return null;
}

export interface IndexEventsState {
  connected: boolean;
  /** attempts since the last successful open; 0 while healthy */
  retries: number;
}

/**
 * `server/sse.ts` writes every frame with a named `event:` field (`progress`, `indexed`, …),
 * so `EventSource.onmessage` — which only fires for the default `message` type — never sees
 * them. Subscribe to each name explicitly, and keep `message` as a fallback in case the
 * server ever emits unnamed frames.
 */
const SSE_EVENT_NAMES: IndexEvent['type'][] = ['progress', 'sessionsChanged', 'indexed', 'error', 'ping'];

/** A stream that stayed open this long counts as healthy and resets the retry backoff. */
const STABLE_STREAM_MS = 10_000;

/**
 * Subscribes to `GET /api/events`. Reconnects with capped exponential backoff and
 * re-bootstraps the session cookie before each retry (the stream 401s without it).
 */
export function useIndexEvents(onEvent: IndexEventHandler): IndexEventsState {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [state, setState] = useState<IndexEventsState>({ connected: false, retries: 0 });

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let openedAt = 0;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(`${API_BASE}/events`);
      const stream = source;
      stream.onopen = () => {
        openedAt = Date.now();
        setState({ connected: true, retries: 0 });
      };
      const onFrame = (message: MessageEvent<string>): void => {
        const event = parseIndexEvent(message.data);
        if (event) handler.current(event);
      };
      stream.onmessage = onFrame;
      for (const name of SSE_EVENT_NAMES) stream.addEventListener(name, onFrame as EventListener);
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        // Reset the backoff only after a connection that actually held. A server that
        // accepts and immediately drops would otherwise be retried every second forever.
        if (openedAt !== 0 && Date.now() - openedAt >= STABLE_STREAM_MS) attempt = 0;
        openedAt = 0;
        attempt += 1;
        setState({ connected: false, retries: attempt });
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
        timer = setTimeout(() => {
          void ensureSession()
            .catch(() => undefined)
            .then(connect);
        }, delay);
      };
    };

    void ensureSession()
      .catch(() => undefined)
      .then(connect);

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);

  return state;
}
