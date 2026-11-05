/**
 * TanStack Query bindings. One hook per endpoint, stable query keys, and a single
 * subscription that invalidates the affected caches when the indexer reports work.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';
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
  SessionsQuery,
  SessionsResponse,
  StatusResponse,
  ToolsAnalyticsResponse,
  TranscriptPage,
  UserSettings,
} from '@core/types';
import { api, useIndexEvents, type IndexEventsState } from './api';

/** ~a minute of freshness for anything derived from the index. */
const ANALYTICS_STALE = 60_000;
const REFERENCE_STALE = 5 * 60_000;

export const queryKeys = {
  status: () => ['status'] as const,
  projects: (query: RangeQuery) => ['projects', query] as const,
  sessions: (query: SessionsQuery) => ['sessions', query] as const,
  session: (sessionId: string, whatIf?: string) => ['session', sessionId, whatIf ?? null] as const,
  transcript: (sessionId: string, agentId: string | null, fromSeq: number, limit: number, whatIf?: string) =>
    ['transcript', sessionId, agentId, fromSeq, limit, whatIf ?? null] as const,
  agents: (sessionId: string, whatIf?: string) => ['agents', sessionId, whatIf ?? null] as const,
  search: (query: SearchQuery) => ['search', query] as const,
  overview: (query: RangeQuery) => ['overview', query] as const,
  toolsAnalytics: (query: RangeQuery) => ['analytics', 'tools', query] as const,
  modelsAnalytics: (query: RangeQuery) => ['analytics', 'models', query] as const,
  hooksAnalytics: (query: RangeQuery) => ['analytics', 'hooks', query] as const,
  attributionAnalytics: (query: RangeQuery) => ['analytics', 'attribution', query] as const,
  insights: (query: RangeQuery) => ['analytics', 'insights', query] as const,
  pricing: () => ['pricing'] as const,
  settings: () => ['settings'] as const,
};

export function useStatus(): UseQueryResult<StatusResponse> {
  return useQuery({
    queryKey: queryKeys.status(),
    queryFn: ({ signal }) => api.status(signal),
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.indexing ? 2_000 : false),
  });
}

export function useProjects(query: RangeQuery = {}): UseQueryResult<ProjectsResponse> {
  return useQuery({
    queryKey: queryKeys.projects(query),
    queryFn: ({ signal }) => api.projects(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useSessions(query: SessionsQuery, enabled = true): UseQueryResult<SessionsResponse> {
  return useQuery({
    queryKey: queryKeys.sessions(query),
    queryFn: ({ signal }) => api.sessions(query, signal),
    staleTime: ANALYTICS_STALE,
    enabled,
  });
}

/** Cursor-paginated session list for the long tables. */
export function useSessionsInfinite(query: SessionsQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessions(query),
    queryFn: ({ pageParam, signal }) =>
      api.sessions({ ...query, cursor: (pageParam as string | undefined) ?? undefined }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SessionsResponse) => last.nextCursor ?? undefined,
    staleTime: ANALYTICS_STALE,
    enabled,
  });
}

export function useSession(sessionId: string | undefined, whatIf?: string): UseQueryResult<SessionDetail> {
  return useQuery({
    queryKey: queryKeys.session(sessionId ?? '', whatIf),
    queryFn: ({ signal }) => api.session(sessionId as string, { whatIf }, signal),
    staleTime: ANALYTICS_STALE,
    enabled: Boolean(sessionId),
  });
}

export function useTranscript(
  sessionId: string | undefined,
  options: { agentId?: string | null; fromSeq?: number; limit?: number; whatIf?: string } = {},
): UseQueryResult<TranscriptPage> {
  const agentId = options.agentId ?? null;
  const fromSeq = options.fromSeq ?? 0;
  const limit = options.limit ?? 200;
  return useQuery({
    queryKey: queryKeys.transcript(sessionId ?? '', agentId, fromSeq, limit, options.whatIf),
    queryFn: ({ signal }) =>
      api.transcript(sessionId as string, { agentId, fromSeq, limit, whatIf: options.whatIf }, signal),
    staleTime: ANALYTICS_STALE,
    enabled: Boolean(sessionId),
  });
}

export function useAgentTree(sessionId: string | undefined, whatIf?: string): UseQueryResult<AgentTreeResponse> {
  return useQuery({
    queryKey: queryKeys.agents(sessionId ?? '', whatIf),
    queryFn: ({ signal }) => api.agents(sessionId as string, { whatIf }, signal),
    staleTime: ANALYTICS_STALE,
    enabled: Boolean(sessionId),
  });
}

export function useSearch(query: SearchQuery, enabled = true): UseQueryResult<SearchResponse> {
  return useQuery({
    queryKey: queryKeys.search(query),
    queryFn: ({ signal }) => api.search(query, signal),
    staleTime: 30_000,
    enabled: enabled && query.q.trim().length > 0,
  });
}

export function useOverview(query: RangeQuery): UseQueryResult<OverviewResponse> {
  return useQuery({
    queryKey: queryKeys.overview(query),
    queryFn: ({ signal }) => api.overview(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useToolsAnalytics(query: RangeQuery): UseQueryResult<ToolsAnalyticsResponse> {
  return useQuery({
    queryKey: queryKeys.toolsAnalytics(query),
    queryFn: ({ signal }) => api.toolsAnalytics(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useModelsAnalytics(query: RangeQuery): UseQueryResult<ModelsAnalyticsResponse> {
  return useQuery({
    queryKey: queryKeys.modelsAnalytics(query),
    queryFn: ({ signal }) => api.modelsAnalytics(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useHooksAnalytics(query: RangeQuery): UseQueryResult<HooksAnalyticsResponse> {
  return useQuery({
    queryKey: queryKeys.hooksAnalytics(query),
    queryFn: ({ signal }) => api.hooksAnalytics(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useAttributionAnalytics(query: RangeQuery): UseQueryResult<AttributionAnalyticsResponse> {
  return useQuery({
    queryKey: queryKeys.attributionAnalytics(query),
    queryFn: ({ signal }) => api.attributionAnalytics(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function useInsights(query: RangeQuery): UseQueryResult<InsightsResponse> {
  return useQuery({
    queryKey: queryKeys.insights(query),
    queryFn: ({ signal }) => api.insights(query, signal),
    staleTime: ANALYTICS_STALE,
  });
}

export function usePricing(): UseQueryResult<PricingConfig> {
  return useQuery({
    queryKey: queryKeys.pricing(),
    queryFn: ({ signal }) => api.pricing(signal),
    staleTime: REFERENCE_STALE,
  });
}

export function useSettings(): UseQueryResult<UserSettings> {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: ({ signal }) => api.settings(signal),
    staleTime: REFERENCE_STALE,
  });
}

export function useUpdatePricing(): UseMutationResult<PricingConfig, Error, PricingConfig> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (config: PricingConfig) => api.updatePricing(config),
    onSuccess: (config) => {
      client.setQueryData(queryKeys.pricing(), config);
      void client.invalidateQueries({ queryKey: ['analytics'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useResetPricing(): UseMutationResult<PricingConfig, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.resetPricing(),
    onSuccess: (config) => {
      client.setQueryData(queryKeys.pricing(), config);
      void client.invalidateQueries();
    },
  });
}

export function useUpdateSettings(): UseMutationResult<UserSettings, Error, UserSettings> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: UserSettings) => api.updateSettings(settings),
    onSuccess: (settings) => client.setQueryData(queryKeys.settings(), settings),
  });
}

/** Toggles the pin on a session; the server returns the resulting state. */
export function usePinSession(): UseMutationResult<{ pinned: boolean }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.pinSession(sessionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: ['session'] });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export function useReindex(): UseMutationResult<{ started: true }, Error, boolean | void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (full: boolean | void) => api.reindex(full === true),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.status() }),
  });
}

/**
 * Single SSE subscription for the app. Invalidates the caches an index run can change
 * and forwards every event to the caller (the status pill renders progress from it).
 */
export function useIndexEventStream(onEvent?: (event: IndexEvent) => void): IndexEventsState {
  const client = useQueryClient();
  const handle = useCallback(
    (event: IndexEvent) => {
      switch (event.type) {
        case 'indexed':
          void client.invalidateQueries();
          break;
        case 'sessionsChanged':
          void client.invalidateQueries({ queryKey: ['sessions'] });
          void client.invalidateQueries({ queryKey: ['session'] });
          void client.invalidateQueries({ queryKey: ['overview'] });
          void client.invalidateQueries({ queryKey: ['projects'] });
          void client.invalidateQueries({ queryKey: ['analytics'] });
          break;
        case 'error':
          void client.invalidateQueries({ queryKey: queryKeys.status() });
          break;
        case 'progress':
        case 'ping':
          break;
      }
      onEvent?.(event);
    },
    [client, onEvent],
  );
  return useIndexEvents(handle);
}
