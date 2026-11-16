/** Builds synthetic OpenCode databases (both storage layouts). Never copies a real database. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);

export function createLegacyDb(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE credential (id text, secret text);
  `);
  const session = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)');
  const message = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  session.run('ses_root', 'prj', null, 'brave-fox', '/workspace/example', 'Fix the synthetic parser', '1.2.0', T0, T0 + 60_000);
  session.run('ses_child', 'prj', 'ses_root', 'quiet-owl', '/workspace/example', 'Child session - 2026-11-03', '1.2.0', T0 + 5_000, T0 + 30_000);
  const user = (id: string, sid: string, text: string, t: number) => {
    message.run(id, sid, t, t, JSON.stringify({ role: 'user', time: { created: t } }));
    part.run(`${id}_p`, id, sid, t, t, JSON.stringify({ type: 'text', text }));
  };
  const assistant = (id: string, sid: string, t: number, tokens: unknown, parts: unknown[]) => {
    message.run(id, sid, t, t, JSON.stringify({ role: 'assistant', time: { created: t, completed: t + 1000 }, modelID: 'claude-sonnet-4.5', providerID: 'github-copilot', path: { cwd: '/workspace/example' }, cost: 0, ...(tokens ? { tokens } : {}) }));
    parts.forEach((data, i) => part.run(`${id}_p${i}`, id, sid, t + i, t + i, JSON.stringify(data)));
  };
  user('m1', 'ses_root', 'Please fix the synthetic parser', T0);
  assistant('m2', 'ses_root', T0 + 1000, { input: 100, output: 40, reasoning: 10, cache: { read: 500, write: 200 } }, [
    { type: 'reasoning', text: 'thinking about it' },
    { type: 'tool', callID: 'call_1', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'file body' } },
    { type: 'text', text: 'Done with the parser' },
  ]);
  user('m3', 'ses_root', 'Thanks', T0 + 20_000);
  assistant('m4', 'ses_root', T0 + 21_000, undefined, [{ type: 'text', text: 'No telemetry recorded' }]);
  user('c1', 'ses_child', 'Explore the synthetic repo', T0 + 5_000);
  assistant('c2', 'ses_child', T0 + 6_000, { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, [{ type: 'text', text: 'Explored' }]);
  db.close();
  return file;
}

export function createV2Db(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
  `);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?)').run('ses_v2', 'prj', null, 'calm-bee', '/workspace/v2', 'Add the synthetic feature', '2.0.0', T0, T0 + 9_000);
  const insert = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  let seq = 0;
  const add = (id: string, type: string, t: number, data: unknown) => insert.run(id, 'ses_v2', type, seq++, t, t, JSON.stringify(data));
  add('v1', 'system', T0, { time: { created: T0 }, text: 'Injected instructions' });
  add('v2', 'user', T0 + 1, { time: { created: T0 + 1 }, text: 'Add the synthetic feature' });
  add('v3', 'assistant', T0 + 2, {
    time: { created: T0 + 2 }, model: { id: 'claude-opus-4-5', providerID: 'github-copilot', variant: 'high' }, finish: 'tool-calls', cost: 0.5,
    tokens: { input: 4, output: 148, reasoning: 142, cache: { read: 5348, write: 6673 } },
    content: [
      { type: 'reasoning', text: 'plan' },
      { type: 'tool', id: 'call_a', name: 'shell', state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'listing' }] } },
      { type: 'tool', id: 'call_b', name: 'shell', state: { status: 'error', input: { command: 'false' }, content: [{ type: 'text', text: 'failed' }] } },
    ],
  });
  add('v4', 'assistant', T0 + 3, { time: { created: T0 + 3 }, model: { id: 'claude-opus-4-5', providerID: 'github-copilot' }, finish: 'error', error: { message: 'rate limited', status: 429 }, content: [] });
  add('v5', 'idle', T0 + 4, { time: { created: T0 + 4 }, outcome: 'completed' });
  db.close();
  return file;
}
