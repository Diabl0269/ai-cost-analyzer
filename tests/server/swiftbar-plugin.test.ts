/** Smoke test for integrations/swiftbar/ai-cost-analyzer.5m.sh against a stub server (macOS only: osascript). */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('integrations/swiftbar/ai-cost-analyzer.5m.sh');
const usage = (cost: number | null, costStatus: string, sessions = 1) => ({
  cost,
  costStatus,
  tokens: { input: 1500, output: 500, cacheRead: 0, cacheWrite: 0, total: 2000 },
  sessions,
  unavailableSessions: costStatus === 'unavailable' ? 1 : 0,
  partialSessions: 0,
});
const idle = usage(0, 'recorded', 0);
const period = (claude: ReturnType<typeof usage>, codex: ReturnType<typeof usage>, total: ReturnType<typeof usage>) => ({
  range: { from: '2026-09-07', to: '2026-09-07' },
  total,
  byProvider: { claude, codex, copilot: idle, opencode: idle },
});
const body = {
  generatedAt: '2026-09-07T12:00:00.000Z',
  periods: {
    today: period(usage(1.5, 'recorded'), usage(null, 'unavailable'), usage(1.5, 'partial', 2)),
    week: period(usage(9, 'recorded'), usage(null, 'unavailable'), usage(9, 'partial', 2)),
  },
  indexing: false,
  indexFailureCount: 2,
  lastIndexedAt: null,
  budget: { monthlyBudgetUsd: null, month: '2026-09', spent: 0, forecast: 0, daysElapsed: 7, daysInMonth: 30 },
};

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function run(port: number): Promise<string> {
  return new Promise((res, rej) =>
    execFile('/bin/bash', [SCRIPT], { env: { ...process.env, CCA_PORT: String(port) } }, (err, stdout) => (err ? rej(err) : res(stdout))),
  );
}

describe.skipIf(process.platform !== 'darwin')('swiftbar plugin', () => {
  it('authenticates with a cookie and renders title, providers and links', async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/auth/session') {
        res.setHeader('set-cookie', 'cca_session=abc; Path=/').end('{}');
      } else if (req.url === '/api/analytics/summary' && req.headers.cookie?.includes('cca_session=abc')) {
        res.setHeader('content-type', 'application/json').end(JSON.stringify(body));
      } else res.statusCode = 401, res.end('{}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const out = await run((server.address() as AddressInfo).port);
    const lines = out.split('\n');
    expect(lines[0]).toBe('$1.50+ today ⚠');
    expect(out).toContain('Claude Code: $1.50 today · $9.00 week');
    expect(out).toContain('Codex: n/a today · n/a week');
    expect(out).not.toContain('Copilot');
    expect(out).toContain('2 session(s) failed to index');
    expect(out).toContain('Open dashboard | href=http://127.0.0.1:');
    expect(out).toContain('Refresh | refresh=true');
  });

  it('shows estimates beside, never inside, recorded cost', async () => {
    const withEstimate = (u: ReturnType<typeof usage>, estimatedCost: number) => ({ ...u, estimatedCost });
    const est = {
      ...body,
      indexFailureCount: 0,
      periods: {
        today: period(usage(1.5, 'recorded'), withEstimate(usage(null, 'unpriced'), 0.4), withEstimate(usage(1.5, 'partial', 2), 0.4)),
        week: period(usage(9, 'recorded'), withEstimate(usage(null, 'unpriced'), 2), withEstimate(usage(9, 'partial', 2), 2)),
      },
    };
    server = createServer((req, res) => {
      if (req.method === 'POST') res.setHeader('set-cookie', 'cca_session=abc; Path=/').end('{}');
      else res.setHeader('content-type', 'application/json').end(JSON.stringify(est));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const out = await run((server.address() as AddressInfo).port);
    expect(out).toContain('Codex: ≈ $0.40 (estimate) today · ≈ $2.00 (estimate) week');
    expect(out).toContain('Today $1.50+ + ≈ $0.40 (estimate) · 7 days $9.00+ + ≈ $2.00 (estimate)');
    expect(out.split('\n')[0]).toBe('$1.50+ today');
  });

  it('shows offline when nothing is listening', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const out = await run(port);
    expect(out.split('\n')[0]).toBe('⚠ offline | color=red');
  });
});
