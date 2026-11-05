/** Copilot SDK session events → shared readable transcript blocks. Streaming deltas are ignored. */
import { asRecord, list, parseJson, rec, str } from '../parse/raw.js';

export function normalizeCopilotLine(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = rec(raw, 'data');
  if (!data) return undefined;
  const envelope = { timestamp: str(raw, 'timestamp'), uuid: str(raw, 'id') };
  const type = str(raw, 'type');
  if (type === 'user.message') return {
    ...envelope, type: 'user', isMeta: data['isAutopilotContinuation'] === true,
    message: { content: str(data, 'content') ?? '' },
  };
  if (type === 'assistant.message') {
    const content: Record<string, unknown>[] = [];
    const reasoning = str(data, 'reasoningText');
    if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
    if (str(data, 'content')) content.push({ type: 'text', text: data['content'] });
    // Tool execution_start owns tool-use blocks, avoiding duplicate calls from toolRequests.
    return { ...envelope, type: 'assistant', message: { id: str(data, 'messageId'), model: str(data, 'model'), content } };
  }
  if (type === 'tool.execution_start') {
    const input = data['arguments'];
    const server = str(data, 'mcpConfigServerName') ?? str(data, 'mcpServerName');
    const name = server ? `mcp__${server}__${str(data, 'mcpToolName') ?? str(data, 'toolName') ?? 'unknown'}` : str(data, 'toolName') ?? 'unknown';
    return { ...envelope, type: 'assistant', message: { model: str(data, 'model'), content: [{
      type: 'tool_use', id: str(data, 'toolCallId') ?? '', name,
      input: typeof input === 'string' ? parseJson(input) ?? input : input,
    }] } };
  }
  if (type === 'tool.execution_complete') {
    const result = rec(data, 'result');
    const error = rec(data, 'error');
    return { ...envelope, type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: str(data, 'toolCallId') ?? '', is_error: data['success'] === false,
      content: str(result, 'content') ?? str(result, 'detailedContent') ?? str(error, 'message') ?? '',
    }] } };
  }
  if (type === 'session.compaction_complete' && data['success'] === true) return {
    ...envelope, type: 'user', isCompactSummary: true, message: { content: str(data, 'summaryContent') ?? '' },
  };
  if (type === 'abort') return { ...envelope, type: 'system', subtype: 'interrupt', content: 'Turn interrupted' };
  if (type === 'system.message') return {
    ...envelope, type: 'user', isMeta: true,
    message: { content: str(data, 'content') ?? list(data, 'content').map((item) => str(asRecord(item), 'text') ?? '').join('\n') },
  };
  return undefined;
}
