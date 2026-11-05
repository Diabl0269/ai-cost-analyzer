/**
 * The tour. One entry per scene: what it says, the floor for how long it stays on screen, and the
 * interactions that fill it. Selectors are roles, labels and the app's own `data-` hooks, never
 * CSS-module class names (those are hashed at build time).
 */
import type { Stage } from './stage.js';

export interface SceneRunContext {
  stage: Stage;
  /** id of the most expensive session in range, or null when the index holds none */
  sessionId: string | null;
  /** a term the caller has already checked returns hits against this index */
  searchQuery: string;
}

export interface Scene {
  id: string;
  /** spoken over the scene; also written to `narration.txt` */
  narration: string;
  /** seconds — the scene never gets less than this, however short the narration is */
  min: number;
  run(context: SceneRunContext): Promise<void>;
}

/** Where the poster frame is cut from. */
export const POSTER_SCENE = 'overview-kpis';

export const SCENES: Scene[] = [
  {
    id: 'intro',
    narration:
      'AI Cost Analyzer prices every token Claude Code spends — on your own machine, from the transcripts it already writes.',
    min: 5,
    async run({ stage }) {
      await stage.safe('intro card', async () => {
        await stage.card('intro', 'AI Cost Analyzer', 'Every token, priced.');
      });
      await stage.pause(2_500);
      await stage.safe('intro fade', () => stage.fadeCard());
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'overview-kpis',
    narration:
      'The overview opens on the money: spend, requests, cache hit ratio, cost per prompt. Every number says how it was computed.',
    min: 8,
    async run({ stage }) {
      await stage.safe('overview', () => stage.goto('/'));
      await stage.hover('button[aria-label="How Spend is calculated"]', 1_200, 'spend hint');
      await stage.hover('button[aria-label="How Cache hit ratio is calculated"]', 1_200, 'cache hint');
      await stage.safe('daily bar', async () => {
        const bars = stage.page.locator('[data-day-index]');
        const count = await bars.count();
        if (count === 0) {
          stage.log('  skip daily bar: no days in range');
          return;
        }
        await stage.hover(bars.nth(Math.max(0, count - 3)), 1_300, 'daily bar');
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'overview-breakdown',
    narration:
      'The same total, split by model and by project.',
    min: 6,
    async run({ stage }) {
      await stage.safe('scroll to model spend', async () => {
        await stage.wheel(900, 14);
      });
      await stage.hover('table tbody tr', 900, 'model row');
      await stage.safe('scroll to project spend', async () => {
        await stage.wheel(750, 12);
      });
      await stage.safe('rail project tree', async () => {
        const collapsed = stage.page.locator('[data-app-rail] [role="treeitem"][aria-expanded="false"]');
        if ((await collapsed.count()) > 0) await stage.click(collapsed.first(), 'expand project');
        else await stage.hover('[data-app-rail] [role="treeitem"]', 800, 'project row');
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'sessions',
    narration:
      'The ledger lists every session with its cost, and checks each one against Claude Code’s own tally. Open the most expensive.',
    min: 7,
    async run({ stage, sessionId }) {
      await stage.safe('sessions', () => stage.goto('/sessions'));
      await stage.safe('hover rows', async () => {
        const rows = stage.page.locator('tr[data-row-index]');
        const count = Math.min(3, await rows.count());
        for (let i = 0; i < count; i++) await stage.hover(rows.nth(i), 520, `row ${i}`);
      });
      if (sessionId) {
        await stage.safe('open session', async () => {
          const link = stage.page.locator(`a[href*="/sessions/${encodeURIComponent(sessionId)}"]`);
          if ((await link.count()) > 0) await stage.click(link.first(), 'session link');
          else await stage.goto(`/sessions/${encodeURIComponent(sessionId)}`);
          await stage.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        });
      } else {
        stage.log('  skip open session: index holds no sessions');
      }
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'session-summary',
    narration:
      'A session is a receipt: exact token costs, where the work happened, and every request as a waterfall.',
    min: 8,
    async run({ stage }) {
      await stage.hover('text=Receipt — exact', 900, 'receipt');
      await stage.safe('scroll to waterfall', async () => {
        await stage.wheel(1_100, 14);
      });
      await stage.safe('waterfall bars', async () => {
        const bars = stage.page.locator('[data-bar-index]');
        const count = await bars.count();
        if (count === 0) {
          stage.log('  skip waterfall: no requests charted');
          return;
        }
        await stage.hover(bars.nth(Math.floor(count / 2)), 1_000, 'waterfall bar');
        if (count > 1) await stage.hover(bars.nth(Math.max(0, count - 1)), 900, 'last bar');
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'session-transcript',
    narration:
      'The transcript prices the conversation turn by turn. Every tool call carries its own estimate.',
    min: 7,
    async run({ stage }) {
      await stage.safe('transcript tab', () => stage.click('[role="tab"]:has-text("Transcript")', 'transcript tab'));
      await stage.pause(700);
      await stage.safe('scroll transcript', async () => {
        await stage.wheel(1_000, 16, 80);
      });
      await stage.hover('[data-turn]', 900, 'turn header');
      await stage.safe('tools tab', () => stage.click('[role="tab"]:has-text("Tools")', 'tools tab'));
      await stage.pause(500);
      await stage.hover('tr[data-row-index]', 1_100, 'tool row');
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'session-agents',
    narration: 'Subagents and workflow runs get their own tree, priced separately.',
    min: 5,
    async run({ stage }) {
      await stage.safe('agents tab', () => stage.click('[role="tab"]:has-text("Agents")', 'agents tab'));
      await stage.pause(700);
      await stage.hover('[data-app-rail] [role="treeitem"]', 800, 'agent tree');
      await stage.safe('scroll agents', () => stage.wheel(500, 8));
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'session-hooks',
    narration: 'Hooks and harness injections are priced too — the tokens nobody typed.',
    min: 4.5,
    async run({ stage }) {
      await stage.safe('hooks tab', () => stage.click('[role="tab"]:has-text("Hooks")', 'hooks tab'));
      await stage.pause(700);
      await stage.safe('scroll hooks', () => stage.wheel(600, 9));
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'search',
    narration:
      'Full-text search runs over every indexed transcript, with the match highlighted in place.',
    min: 7.5,
    async run({ stage, searchQuery }) {
      await stage.safe('search', () => stage.goto('/search'));
      await stage.safe('type query', () => stage.typeInto('[data-page-search]', searchQuery, 'search field'));
      await stage.safe('submit', async () => {
        await stage.page.keyboard.press('Enter');
        await stage.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      });
      await stage.pause(900);
      await stage.safe('hits', async () => {
        const hits = stage.page.locator('[data-hit]');
        if ((await hits.count()) === 0) {
          stage.log('  skip hits: nothing matched');
          return;
        }
        await stage.hover(hits.first(), 1_100, 'first hit');
        await stage.click(hits.first(), 'open hit');
        await stage.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'analytics-tools',
    narration: 'Analytics rolls it up by tool, by model and by hook.',
    min: 6,
    async run({ stage }) {
      await stage.safe('tools analytics', () => stage.goto('/analytics/tools'));
      await stage.hover('tr[data-row-index]', 800, 'tool row');
      await stage.safe('sort by cost', async () => {
        const header = stage.page.locator('th button:has-text("Total")');
        if ((await header.count()) > 0) await stage.click(header.first(), 'sort total');
      });
      await stage.safe('scroll tools', () => stage.wheel(700, 10));
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'insights',
    narration: 'Insights turns it into findings, ranked by the money at stake.',
    min: 5.5,
    async run({ stage }) {
      await stage.safe('insights', () => stage.goto('/insights'));
      await stage.safe('scroll insights', () => stage.wheel(650, 10));
      await stage.hover('h2', 700, 'insight group');
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'settings-pricing',
    narration:
      'Prices are editable. Money is computed at read time, so a new rate re-prices your whole history instantly.',
    min: 7.5,
    async run({ stage }) {
      await stage.safe('settings', () => stage.goto('/settings#pricing'));
      await stage.safe('pricing nav', async () => {
        const link = stage.page.locator('a[href*="#pricing"], button:has-text("Pricing")');
        if ((await link.count()) > 0) await stage.click(link.first(), 'pricing link');
      });
      await stage.safe('scroll pricing', () => stage.wheel(600, 9));
      await stage.safe('edit a price', async () => {
        // The draft is local until Save; the demo never saves, so the server's table is untouched.
        const cell = stage.page.locator('table input[type="text"], table input[inputmode="decimal"], table input[type="number"]');
        if ((await cell.count()) === 0) {
          stage.log('  skip edit a price: no editable cell');
          return;
        }
        await stage.click(cell.first(), 'price cell');
        await stage.page.keyboard.press('Meta+a');
        await stage.page.keyboard.type('9.5', { delay: 90 });
        await stage.pause(1_200);
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'palette',
    narration: 'Command-K reaches any page, session or project.',
    min: 5,
    async run({ stage }) {
      await stage.safe('open palette', async () => {
        await stage.page.keyboard.press('Meta+k');
        await stage.pause(600);
        await stage.page.keyboard.type('sessions', { delay: 70 });
        await stage.pause(1_400);
        await stage.page.keyboard.press('Escape');
      });
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'theme',
    narration: 'And it reads the same in slate as on paper.',
    min: 4.5,
    async run({ stage }) {
      await stage.safe('overview', () => stage.goto('/'));
      await stage.safe('theme toggle', async () => {
        const toggle = stage.page.locator('button[aria-label^="Theme:"]');
        if ((await toggle.count()) === 0) {
          stage.log('  skip theme toggle: not found');
          return;
        }
        await stage.click(toggle.first(), 'theme toggle');
        // system → paper → slate: press until the dark palette is in effect.
        for (let i = 0; i < 3; i++) {
          const theme = await stage.currentTheme();
          if (theme === 'slate') break;
          await stage.click(toggle.first(), 'theme toggle');
        }
      });
      await stage.pause(900);
      await stage.holdUntilEnd();
    },
  },
  {
    id: 'outro',
    narration: 'Local, private, exact. One command, no account, no key.',
    min: 5.5,
    async run({ stage }) {
      await stage.safe('outro card', () => stage.card('outro', 'Local. Private. Exact.', 'npm start — reads ~/.claude/projects'));
      await stage.holdUntilEnd();
    },
  },
];
