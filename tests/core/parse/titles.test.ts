import { describe, expect, it } from 'vitest';
import { cleanPrompt, resolveTitle } from '../../../core/parse/index.js';

describe('cleanPrompt', () => {
  it('collapses whitespace and caps at 120 characters', () => {
    expect(cleanPrompt('  Rename   the\n helper  ')).toBe('Rename the helper');
    expect(cleanPrompt('x'.repeat(300))).toHaveLength(120);
    expect(cleanPrompt('')).toBe('');
  });

  it('uses readable Markdown link labels without displaying local paths or URLs', () => {
    expect(cleanPrompt('[$jira:create-jira-ticket](/workspace/skills/create-jira-ticket/SKILL.md) Create a bug')).toBe('$jira:create-jira-ticket Create a bug');
    expect(cleanPrompt('[docs](https://example.test/docs) and [local](</workspace/My Skills/SKILL.md>)')).toBe('docs and local');
    expect(cleanPrompt('[local](/workspace/skills(copy)/SKILL.md)')).toBe('local');
    expect(cleanPrompt('![Screenshot](/workspace/screenshot.png)')).toBe('![Screenshot](/workspace/screenshot.png)');
  });

  it('renders a slash command as /<command> <args>', () => {
    const raw = '<command-name>/pr-review-flow</command-name>\n<command-message>pr-review-flow</command-message>\n<command-args>PR 42 on dev/alpha</command-args>';
    expect(cleanPrompt(raw)).toBe('/pr-review-flow PR 42 on dev/alpha');
  });

  it('keeps a command name that has no args and no leading slash', () => {
    expect(cleanPrompt('<command-name>status</command-name>')).toBe('/status');
  });

  it('drops system-reminder, task-notification and local-command wrappers', () => {
    expect(cleanPrompt('<system-reminder>ignore me</system-reminder>Real text')).toBe('Real text');
    expect(cleanPrompt('Real text<task-notification>\n<task-id>x</task-id>\n</task-notification>')).toBe('Real text');
    expect(cleanPrompt('<local-command-stdout>output</local-command-stdout>Real text')).toBe('Real text');
    expect(cleanPrompt('<local-command-caveat>caveat</local-command-caveat>')).toBe('');
  });

  it('keeps the prose that follows a slash command', () => {
    const raw = '<command-name>/fork</command-name><command-args>check the MCP</command-args>and then stop';
    expect(cleanPrompt(raw)).toBe('/fork check the MCP and then stop');
  });
});

describe('resolveTitle', () => {
  const sessionId = 'a1111111-1111-4111-8111-111111111111';
  const all = {
    customTitle: 'Custom line',
    customTitleFromFile: 'Custom file',
    aiTitle: 'AI title',
    agentName: 'Agent name',
    indexSummary: 'Index summary',
    firstPrompt: 'First prompt',
    slug: 'the-slug',
    sessionId,
  };

  it('follows the SPEC §4 priority order as each source is removed', () => {
    const steps: [Partial<typeof all>, string, string][] = [
      [{}, 'Custom line', 'custom-title'],
      [{ customTitle: undefined }, 'Custom file', 'custom-title-file'],
      [{ customTitle: undefined, customTitleFromFile: undefined }, 'AI title', 'ai-title'],
      [{ customTitle: undefined, customTitleFromFile: undefined, aiTitle: undefined }, 'Agent name', 'agent-name'],
      [{ customTitle: undefined, customTitleFromFile: undefined, aiTitle: undefined, agentName: undefined }, 'Index summary', 'sessions-index'],
      [{ customTitle: undefined, customTitleFromFile: undefined, aiTitle: undefined, agentName: undefined, indexSummary: undefined }, 'First prompt', 'first-prompt'],
      [{ customTitle: undefined, customTitleFromFile: undefined, aiTitle: undefined, agentName: undefined, indexSummary: undefined, firstPrompt: undefined }, 'the-slug', 'slug'],
    ];
    for (const [override, title, source] of steps) {
      expect(resolveTitle({ ...all, ...override })).toEqual({ title, source });
    }
  });

  it('uses a complete leading Automation header task name only for the title', () => {
    const prompt = 'Automation: Daily summary\nAutomation ID: daily-summary\nAutomation memory: $CODEX_HOME/automations/daily-summary/memory.md\n\nSummarize the current work.';
    expect(resolveTitle({ firstPrompt: prompt, sessionId }).title).toBe('Daily summary');
    expect(cleanPrompt(prompt)).toContain('Automation ID: daily-summary');
    for (const quoted of [
      'Explain this metadata:\n' + prompt,
      '> ' + prompt.replace(/\n/g, '\n> '),
      '```text\n' + prompt + '\n```',
      'Automation: Explain scheduling\nKeep the ID and memory in the result.',
    ]) expect(resolveTitle({ firstPrompt: quoted, sessionId }).title).toBe(cleanPrompt(quoted));
  });

  it('falls back to a short session id', () => {
    expect(resolveTitle({ sessionId })).toEqual({ title: 'a1111111', source: 'session-id' });
  });

  it('skips blank candidates and cleans the first prompt', () => {
    expect(resolveTitle({ customTitle: '   ', firstPrompt: '<command-name>/status</command-name>', sessionId })).toEqual({
      title: '/status', source: 'first-prompt',
    });
  });

  it('caps the resolved title at 120 characters', () => {
    expect(resolveTitle({ customTitle: 'y'.repeat(300), sessionId }).title).toHaveLength(120);
  });
});
