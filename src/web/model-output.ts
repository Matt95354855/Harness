/** GPT-OSS Harmony framing is stripped locally; analysis channels are never shown to the user. */
export function finalContent(content: string): string {
  const marker = '<|channel|>final';
  const position = content.lastIndexOf(marker);
  if (position >= 0) {
    const start = content.indexOf('<|message|>', position);
    if (start < 0) throw new Error('Missing final message');
    content = content.slice(start + '<|message|>'.length);
  } else if (content.includes('<|channel|>analysis') || content.includes('<|channel|>commentary')) {
    throw new Error('Model did not emit a final answer');
  } else if (content.startsWith('<|message|>')) content = content.slice('<|message|>'.length);
  content = content.replace(/<\|(?:return|end|im_end|fim_suffix)\|>[\s\S]*$/, '').trim();
  if (!content) throw new Error('Empty final answer');
  return content;
}

/** Convert a GPT-OSS native Harmony tool call into the Harness decision protocol. */
export function decisionContent(content: string): string {
  const call = content.match(/<\|channel\|>commentary\s+to=([a-z][a-z0-9_]{0,63})(?:\s+<\|constrain\|>json)?<\|message\|>([\s\S]*?)(?:<\|return\|>|<\|end\|>|$)/u);
  if (!call) return finalContent(content);
  let parameters: unknown;
  try { parameters = JSON.parse(call[2]!.trim()); }
  catch { throw new Error('Model emitted invalid tool parameters'); }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Model emitted invalid tool parameters');
  return JSON.stringify({ summary: `Use ${call[1]}.`, nextAction: 'TOOL', confidence: 1, toolName: call[1], parameters });
}
