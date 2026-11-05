import { describe, expect, it } from 'vitest';
import { codexPrompt } from '../../../core/codex/prompts.js';

const agents = '# AGENTS.md instructions for /workspace/synthetic\n\n<INSTRUCTIONS>Follow local conventions.</INSTRUCTIONS>';
const environment = '<environment_context>\n<cwd>/workspace/synthetic</cwd>\n</environment_context>';

describe('Codex prompt envelopes', () => {
  it('classifies complete injected-only context and extracts trailing user prose', () => {
    expect(codexPrompt(`${agents}\n${environment}`)).toMatchObject({ text: '', isMeta: true });
    expect(codexPrompt('# AGENTS.md instructions\n\n<INSTRUCTIONS>Use project conventions.</INSTRUCTIONS>')).toMatchObject({ text: '', isMeta: true });
    expect(codexPrompt(`${environment}\nFix the failing parser.`)).toMatchObject({ text: 'Fix the failing parser.', isMeta: false });
    expect(codexPrompt(`${agents}\n${environment}\nFix the failing parser.`)).toMatchObject({ text: 'Fix the failing parser.', isMeta: false });
    expect(codexPrompt('<task-notification><summary>Task finished</summary></task-notification>').isMeta).toBe(true);
    expect(codexPrompt('<turn_aborted>Earlier turn interrupted</turn_aborted>').isMeta).toBe(true);
  });

  it('keeps browser/IDE state out of the explicit actual request', () => {
    const browser = '<in-app-browser-context tab="synthetic">Selected tab information</in-app-browser-context>\n';
    expect(codexPrompt(`${browser}## Open tabs:\nSynthetic editor state\n## My request:\nExplain the current page.`).text).toBe('Explain the current page.');
    expect(codexPrompt('# Context from my IDE setup:\n## Open tabs:\nSynthetic editor state\n## My request:\nFix the test.').text).toBe('Fix the test.');
  });

  it('retains ordinary user instructions, quoted wrappers and incomplete envelopes', () => {
    for (const text of [
      'Explain this document:\n' + agents,
      '```xml\n' + environment + '\n```\nExplain these instructions.',
      'Write a document containing ## My request: as a heading.',
      '# AGENTS.md instructions for /workspace/synthetic\nPlease explain this heading.',
      '<environment_context>Unclosed example that I need help fixing.',
    ]) expect(codexPrompt(text)).toEqual({ text, harnessChars: 0, isMeta: false });
  });
});
