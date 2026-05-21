import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

let _client: Anthropic | undefined;

export function claude(): Anthropic {
  if (!_client) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export const CLAUDE_MODEL = env.ANTHROPIC_MODEL;

/**
 * Single-shot text-only call. Returns concatenated text content.
 */
export async function claudeText(opts: {
  system?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  // ⚠ claude-opus-4-7 等の新世代モデルでは `temperature` パラメータは deprecated。
  const r = await claude().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });
  return r.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
