/** Maps visible Codex rollout items to the shared transcript display/parser vocabulary. */
import { codexPrompt } from './prompts.js';
import { asRecord, list, parseJson, rec, str } from '../parse/raw.js';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => str(asRecord(part), 'text') ?? '').filter(Boolean).join('\n');
}

export function normalizeCodexLine(
  raw: Record<string, unknown>,
  options: { promptOnly?: boolean } = {},
): Record<string, unknown> | undefined {
  const payload = rec(raw, 'payload');
  if (!payload) return undefined;
  const envelope = { timestamp: str(raw, 'timestamp') };
  const type = str(payload, 'type');
  if (raw['type'] === 'compacted') return {
    ...envelope, type: 'user', isCompactSummary: true,
    message: { content: str(payload, 'message') ?? '' },
  };
  if (raw['type'] === 'event_msg') {
    if (type === 'user_message') {
      const original = str(payload, 'message') ?? '';
      const prompt = codexPrompt(original);
      return { ...envelope, type: 'user', isMeta: prompt.isMeta, codexHarnessChars: prompt.harnessChars, message: { content: options.promptOnly ? prompt.text : original } };
    }
    if (type === 'turn_aborted') return { ...envelope, type: 'system', subtype: 'interrupt', content: 'Turn interrupted' };
    return undefined;
  }
  if (raw['type'] !== 'response_item') return undefined;
  if (type === 'message' || type === 'agent_message') {
    const role = str(payload, 'role') ?? (type === 'agent_message' ? 'user' : 'assistant');
    const content = list(payload, 'content').map((item) => {
      const block = asRecord(item);
      const blockType = str(block, 'type');
      if (blockType === 'input_image' || blockType === 'image') return { type: 'image' };
      return { type: 'text', text: str(block, 'text') ?? '' };
    });
    if (typeof payload['content'] === 'string') content.push({ type: 'text', text: payload['content'] });
    const original = content.map((part) => part.text ?? '').filter(Boolean).join('\n');
    const prompt = codexPrompt(original);
    const roleMeta = role !== 'user' && role !== 'assistant' || type === 'agent_message';
    const isMeta = roleMeta || role === 'user' && prompt.isMeta;
    const parsedContent = options.promptOnly && role === 'user' && prompt.harnessChars > 0
      ? [{ type: 'text', text: prompt.text }, ...content.filter((part) => part.type === 'image')]
      : content;
    return { ...envelope, type: role === 'assistant' ? 'assistant' : 'user', isMeta,
      codexHarnessChars: roleMeta ? original.length : role === 'user' ? prompt.harnessChars : 0,
      message: { content: parsedContent } };

  }
  if (type === 'reasoning') return {
    ...envelope, type: 'assistant', message: { content: [{ type: 'thinking', thinking: text(payload['summary']) }] },
  };
  if (type === 'function_call' || type === 'custom_tool_call') {
    const input = payload['arguments'] ?? payload['input'];
    return { ...envelope, type: 'assistant', message: { content: [{
      type: 'tool_use', id: str(payload, 'call_id') ?? str(payload, 'id') ?? '',
      name: str(payload, 'name') ?? 'unknown', input: typeof input === 'string' ? parseJson(input) ?? input : input,
    }] } };
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') return {
    toolUseResult: { agentId: str(asRecord(typeof payload['output'] === 'string' ? parseJson(payload['output']) : payload['output']), 'agent_id') },
    ...envelope, type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: str(payload, 'call_id') ?? '', content: typeof payload['output'] === 'string' ? payload['output'] : JSON.stringify(payload['output'] ?? ''),
    }] },
  };
  return undefined;
}
