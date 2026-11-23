/** Synthetic Google Antigravity + Gemini CLI builders for tests — zero real user data. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ROOT_CONV_ID = '11111111-2222-4333-8444-555555555555';
export const CHILD_CONV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export function createSyntheticAntigravityDir(baseDir: string): {
  appDir: string;
  brainDir: string;
  rootTranscript: string;
  rootCompactTranscript: string;
  childTranscript: string;
} {
  const appDir = join(baseDir, 'antigravity-cli');
  const brainDir = join(appDir, 'brain');
  mkdirSync(brainDir, { recursive: true });

  const dbPath = join(appDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      app_data_dir TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE conversation_parents (
      conversation_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, step_count, last_modified_time, workspace_uris,
      agent_name, parent_conversation_id, nesting_depth, app_data_dir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    ROOT_CONV_ID,
    'Synthetic Antigravity Feature',
    6,
    '2026-09-12 10:05:00+00:00',
    JSON.stringify(['file:///workspace/synthetic-app']),
    '',
    '',
    0,
    'antigravity-cli',
  );
  insert.run(
    CHILD_CONV_ID,
    'Codebase Researcher',
    2,
    '2026-09-12 10:03:00+00:00',
    JSON.stringify(['file:///workspace/synthetic-app']),
    'research',
    ROOT_CONV_ID,
    1,
    'antigravity-cli',
  );
  db.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(CHILD_CONV_ID, ROOT_CONV_ID);
  db.close();

  const rootLogs = join(brainDir, ROOT_CONV_ID, '.system_generated', 'logs');
  mkdirSync(rootLogs, { recursive: true });
  const rootSteps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-12T10:00:00Z',
      content:
        '<USER_REQUEST>\nAudit the synthetic widget cache\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-12T12:00:00+02:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel Selection: Gemini 4 Carbon (Medium)\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-12T10:00:10Z',
      model: 'gemini-4-carbon-medium',
      input_tokens: 10_000,
      cache_read_tokens: 0,
      output_tokens: 500,
      thinking: 'Inspecting files and delegating research.',
      tool_calls: [
        { name: 'read_file', args: { Path: '/workspace/synthetic-app/src/widget.ts' } },
        { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Codebase Researcher', Model: 'gemini-4-hydrogen-low', Prompt: 'Check widget imports' } },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-09-12T10:00:12Z',
      content: 'export const widget = true;',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-09-12T10:00:14Z',
      content: `Subagent launched with conversationId: ${CHILD_CONV_ID}`,
    },
    {
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-12T10:03:05Z',
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${CHILD_CONV_ID} content=Widget imports verified.\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-12T10:03:15Z',
      model: 'gemini-4-carbon-medium',
      input_tokens: 2_000,
      cache_read_tokens: 10_000,
      output_tokens: 300,
      content: 'Audit complete: widget cache is clean.',
    },
  ];
  const rootTranscript = join(rootLogs, 'transcript_full.jsonl');
  const rootCompactTranscript = join(rootLogs, 'transcript.jsonl');
  const serialized = rootSteps.map((s) => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(rootTranscript, serialized);
  writeFileSync(rootCompactTranscript, serialized);

  const childLogs = join(brainDir, CHILD_CONV_ID, '.system_generated', 'logs');
  mkdirSync(childLogs, { recursive: true });
  const childSteps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-12T10:00:15Z',
      content: '<USER_REQUEST>\nCheck widget imports\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-12T10:01:00Z',
      model: 'gemini-4-hydrogen-low',
      input_tokens: 4_000,
      cache_read_tokens: 1_000,
      output_tokens: 200,
      content: 'All widget imports are valid.',
    },
  ];
  const childTranscript = join(childLogs, 'transcript_full.jsonl');
  writeFileSync(childTranscript, childSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

  return { appDir, brainDir, rootTranscript, rootCompactTranscript, childTranscript };
}

export function createSyntheticGeminiCliDir(baseDir: string): {
  tmpDir: string;
  jsonlSessionPath: string;
  legacyJsonPath: string;
} {
  const geminiDir = join(baseDir, '.gemini');
  const tmpDir = join(geminiDir, 'tmp');
  const projA = join(tmpDir, 'synthetic-app');
  const chatsA = join(projA, 'chats');
  const projB = join(tmpDir, 'mapped-via-projects-json');
  const chatsB = join(projB, 'chats');
  mkdirSync(chatsA, { recursive: true });
  mkdirSync(chatsB, { recursive: true });

  writeFileSync(join(projA, '.project_root'), '/workspace/synthetic-app\n');
  writeFileSync(
    join(geminiDir, 'projects.json'),
    JSON.stringify({ projects: { '/workspace/mapped-app': 'mapped-via-projects-json' } }),
  );

  const jsonlLines = [
    {
      sessionId: 'cli-sess-01',
      projectHash: 'synthetic-app',
      startTime: '2026-09-14T08:00:00.000Z',
      lastUpdated: '2026-09-14T08:01:00.000Z',
      kind: 'main',
    },
    {
      $set: {
        summary: 'Synthetic Gemini CLI session',
        messages: [
          {
            id: 'u1',
            timestamp: '2026-09-14T08:00:01.000Z',
            type: 'user',
            content: [{ text: 'Run synthetic lint check' }],
          },
        ],
      },
    },
    {
      id: 'g1',
      timestamp: '2026-09-14T08:00:15.000Z',
      type: 'gemini',
      model: 'gemini-3.5-flash',
      content: 'Lint passed with zero warnings.',
      thoughts: [{ subject: 'Linting', description: 'Checking command output', timestamp: '2026-09-14T08:00:08.000Z' }],
      toolCalls: [
        {
          id: 'tc1',
          name: 'run_shell_command',
          args: { command: 'npm run lint' },
          resultDisplay: '0 warnings',
          status: 'success',
          timestamp: '2026-09-14T08:00:10.000Z',
        },
      ],
      tokens: {
        input: 5_000,
        output: 100,
        cached: 2_000,
        thoughts: 300,
        tool: 500,
        total: 5_900,
      },
    },
  ];
  const jsonlSessionPath = join(chatsA, 'session-2026-09-14T08-00-cli-sess-01.jsonl');
  writeFileSync(jsonlSessionPath, jsonlLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const legacyJsonPath = join(chatsB, 'session-2026-09-15T09-00-cli-legacy.json');
  writeFileSync(
    legacyJsonPath,
    JSON.stringify({
      sessionId: 'cli-legacy-02',
      projectHash: 'mapped-via-projects-json',
      startTime: '2026-09-15T09:00:00.000Z',
      lastUpdated: '2026-09-15T09:02:00.000Z',
      messages: [
        { id: 'u-leg', timestamp: '2026-09-15T09:00:00.000Z', type: 'user', content: 'Explain legacy layout' },
        {
          id: 'g-leg',
          timestamp: '2026-09-15T09:00:20.000Z',
          type: 'gemini',
          model: 'gemini-2.5-pro',
          content: 'Unbilled reply without telemetry.',
        },
      ],
    }),
  );

  return { tmpDir, jsonlSessionPath, legacyJsonPath };
}
