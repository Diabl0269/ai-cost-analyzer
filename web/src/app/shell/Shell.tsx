import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Outlet, ScrollRestoration, useLocation, useMatches } from 'react-router';
import type { IndexEvent, IndexProgress } from '@core/types';
import { useIndexEventStream, useStatus } from '@/lib/queries';
import { RailSlotContext, type RailSlotApi } from './rail';
import { AppCommands } from './AppCommands';
import { FirstRun } from './FirstRun';
import { Callout } from '@/components/Callout';
import { LeftRail } from './LeftRail';
import { TopBar } from './TopBar';
import styles from './Shell.module.css';
import { useDateRange } from '@/lib/range';

const RAIL_STORAGE_KEY = 'cca.rail';
const APP_NAME = 'AI Cost Analyzer';

/**
 * The routes that are worth reading with an empty index: Settings (where the root is
 * configured), the two prose pages, and the design gallery (invented data). Everything else is a
 * view of transcripts, so with none indexed the shell shows `FirstRun` in their place rather
 * than letting each page blame the reader's filters for a missing data directory.
 */
const INDEX_FREE_ROUTES = ['/settings', '/methodology', '/how-it-works', '/design'];

/** Routes whose whole content comes from the index. */
function needsIndex(pathname: string): boolean {
  const under = (prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (INDEX_FREE_ROUTES.some(under)) return false;
  return pathname === '/' || ['/sessions', '/search', '/analytics', '/insights', '/compare'].some(under);
}

/** Route `handle` shape the shell reads. */
export interface RouteHandle {
  title?: string;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Application frame: top bar, rail, main landmark, palette, focus and title handling. */
export function Shell() {
  const location = useLocation();
  const range = useDateRange();
  const matches = useMatches();
  const mainRef = useRef<HTMLElement | null>(null);
  const lastPath = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railContent, setRailContent] = useState<ReactNode | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [lastIndexedAt, setLastIndexedAt] = useState<string | null>(null);
  const [indexError, setIndexError] = useState<string | null | undefined>(undefined);
  const status = useStatus();
  const visibleIndexError = indexError === undefined ? status.data?.indexError : indexError;

  const onIndexEvent = useCallback((event: IndexEvent) => {
    switch (event.type) {
      case 'progress':
        setProgress(event.progress.phase === 'done' ? null : event.progress);
        break;
      case 'indexed':
        setIndexError(event.indexError ?? null);
        setProgress(null);
        setLastIndexedAt(event.at);
        break;
      case 'error':
        setIndexError(event.message);
        setProgress(null);
        break;
      case 'sessionsChanged':
      case 'ping':
        break;
    }
  }, []);

  const stream = useIndexEventStream(onIndexEvent);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
      /* the rail state simply does not persist */
    }
  }, [collapsed]);

  // Document title per route (SPEC §9).
  useEffect(() => {
    const handles = matches.map((match) => match.handle as RouteHandle | undefined);
    const title = handles.reverse().find((handle) => handle?.title)?.title;
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [matches]);

  // Move focus to the page heading after a navigation, so keyboard users land in the content.
  // Comparing the path (rather than a "first render" flag) keeps this correct under
  // StrictMode's double-invoked effects, which would otherwise steal focus on first paint.
  useEffect(() => {
    setDrawerOpen(false);
    const previous = lastPath.current;
    lastPath.current = location.pathname;
    // `null` = first mount: the user has not navigated, so leave focus at the top of the page.
    if (previous === null || previous === location.pathname) return;
    const main = mainRef.current;
    if (!main) return;
    const heading = main.querySelector<HTMLElement>('h1') ?? main;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }, [location.pathname]);

  // The rail drawer is an overlay with a scrim, so Escape closes it — the same key that closes
  // every other overlay in the app. Focus goes back to the toggle that opened it.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setDrawerOpen(false);
      document.querySelector<HTMLElement>('[data-rail-toggle]')?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const railApi = useMemo<RailSlotApi>(() => ({ content: railContent, setContent: setRailContent }), [railContent]);

  // `undefined` counts mean the first /api/status has not answered; that is "Connecting…", not
  // "no transcripts". Only a settled, non-indexing status with zero sessions is a first run.
  const statusResolved = status.isSuccess || status.isError;
  const firstRun = Boolean(status.data && !status.data.indexing && progress === null && status.data.counts.sessions === 0);
  const showFirstRun = firstRun && needsIndex(location.pathname);

  return (
    <RailSlotContext.Provider value={railApi}>
      <div className={styles.app}>
        <a className={styles.skipLink} href="#main">
          Skip to content
        </a>
        <TopBar
          onToggleRail={() => setDrawerOpen((open) => !open)}
          railExpanded={drawerOpen}
          progress={progress}
          lastIndexedAt={lastIndexedAt ?? status.data?.lastIndexedAt ?? null}
          connected={stream.connected}
          sessionCount={status.data?.counts?.sessions}
          scratchSessions={status.data?.scratchSessions}
          indexError={visibleIndexError}
          roots={status.data?.roots}
          statusResolved={statusResolved}
          firstRun={firstRun}
        />
        <div className={styles.body}>
          <LeftRail
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((value) => !value)}
            drawerOpen={drawerOpen}
            onCloseDrawer={() => setDrawerOpen(false)}
            showRange={!firstRun}
          />
          {drawerOpen ? <button type="button" className={styles.drawerScrim} aria-label="Close navigation" onClick={() => setDrawerOpen(false)} /> : null}
          <main id="main" className={styles.main} ref={mainRef}>
            {visibleIndexError ? <Callout tone="warn" title="Index incomplete">{visibleIndexError} Totals cover only the indexed files. Re-index all roots in Settings to retry.</Callout> : null}
            {!firstRun && range.provider !== 'claude' ? <p className="ui-xs muted" role="note">Codex and Copilot amounts are API-price estimates, not your subscription bill. Claude-only attribution is unavailable for these providers. Copilot request counts include only individually recorded calls.</p> : null}
            {showFirstRun ? <FirstRun roots={status.data?.roots ?? []} /> : <Outlet />}
          </main>
        </div>
        <AppCommands />
        <ScrollRestoration />
      </div>
    </RailSlotContext.Provider>
  );
}
