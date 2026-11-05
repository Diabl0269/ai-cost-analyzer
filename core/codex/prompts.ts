/** Recognize complete, leading Codex harness envelopes; ordinary quoted text stays untouched. */
const CONTEXT_TAGS = [
  'environment_context', 'in-app-browser-context', 'app_specific_instructions',
  'external_codex_apps_open_page', 'guardian_tool_descriptions', 'task-notification', 'turn_aborted',
];

export interface CodexPrompt {
  text: string;
  harnessChars: number;
  isMeta: boolean;
}

export function codexPrompt(content: string): CodexPrompt {
  let rest = content;
  let removed = false;
  for (;;) {
    const agents = /^\s*# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/.exec(rest);
    if (agents) { rest = rest.slice(agents[0].length); removed = true; continue; }
    let matched = false;
    for (const tag of CONTEXT_TAGS) {
      const match = new RegExp(`^\\s*<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>\\s*`).exec(rest);
      if (!match) continue;
      rest = rest.slice(match[0].length);
      removed = true;
      matched = true;
      break;
    }
    if (!matched) break;
  }
  // IDE and browser clients prepend editor state and delimit the actual request explicitly.
  // Only interpret that marker after a recognized harness prefix, never inside ordinary prose.
  if (removed || /^\s*# Context from my IDE setup:/.test(rest)) {
    const request = /^## My request:\s*/m.exec(rest);
    if (request) {
      rest = rest.slice(request.index + request[0].length);
      removed = true;
    }
  }
  if (!removed) return { text: content, harnessChars: 0, isMeta: false };
  return { text: rest.trim(), harnessChars: content.length - rest.trim().length, isMeta: rest.trim().length === 0 };
}
