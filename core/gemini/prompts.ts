/**
 * Recognize complete Antigravity harness envelopes (`<USER_REQUEST>`, `<ADDITIONAL_METADATA>`,
 * `<USER_SETTINGS_CHANGE>`, `<SYSTEM_MESSAGE>`, `<EPHEMERAL_MESSAGE>`) while leaving ordinary
 * user prose — including quoted tags inside `<USER_REQUEST>` — untouched.
 */
const WRAPPER_TAGS = [
  'ADDITIONAL_METADATA',
  'USER_SETTINGS_CHANGE',
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
];

export interface AntigravityPrompt {
  text: string;
  harnessChars: number;
  isMeta: boolean;
}

const LEADING_USER_REQUEST = /^\s*<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;

function stripMetadataTags(input: string): { rest: string; stripped: boolean } {
  let rest = input;
  let stripped = false;
  for (;;) {
    let matched = false;
    for (const tag of WRAPPER_TAGS) {
      const lead = new RegExp(`^\\s*<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>\\s*`).exec(rest);
      if (lead) {
        rest = rest.slice(lead[0].length);
        stripped = true;
        matched = true;
        break;
      }
      const trail = new RegExp(`\\s*(?:The following is a <${tag}>[^\\r\\n]*\\r?\\n\\s*)?<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>\\s*$`).exec(rest);
      if (trail) {
        rest = rest.slice(0, trail.index);
        stripped = true;
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  return { rest, stripped };
}

export function antigravityPrompt(content: string): AntigravityPrompt {
  const req = LEADING_USER_REQUEST.exec(content);
  if (req) {
    const after = content.slice(req[0].length);
    const tail = stripMetadataTags(after);
    // Only unwrap `<USER_REQUEST>` when the remainder is empty or recognized harness metadata.
    if (after.trim().length === 0 || (tail.stripped && tail.rest.trim().length === 0)) {
      const text = (req[1] ?? '').trim();
      return {
        text,
        harnessChars: Math.max(0, content.length - text.length),
        isMeta: text.length === 0,
      };
    }
  }
  const cleaned = stripMetadataTags(content);
  if (!cleaned.stripped) return { text: content, harnessChars: 0, isMeta: false };
  const text = cleaned.rest.trim();
  return {
    text,
    harnessChars: Math.max(0, content.length - text.length),
    isMeta: text.length === 0,
  };
}
