import { describe, it, expect } from 'vitest';
import { buildBody } from '../../src/llm/providers/openaiCompat.js';
import { toAnthropicMessage } from '../../src/llm/providers/AnthropicProvider.js';
import type { CompletionRequest, Message } from '../../src/llm/types.js';

const imageMsg: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'make it look like this' },
    { type: 'image', mediaType: 'image/png', data: 'QUJD' },
  ],
};

describe('image-block translation', () => {
  it('openai-compat encodes an image as an image_url data URL', () => {
    const req: CompletionRequest = {
      model: 'grok-code-fast-1',
      system: 'sys',
      messages: [imageMsg],
      tools: [],
    };
    const body = buildBody(req);
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === 'text')).toBe(true);
    const img = parts.find((p) => p.type === 'image_url');
    expect(img?.image_url?.url).toBe('data:image/png;base64,QUJD');
  });

  it('anthropic encodes an image as a base64 source block', () => {
    const out = toAnthropicMessage(imageMsg) as {
      role: string;
      content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }>;
    };
    const img = out.content.find((b) => b.type === 'image');
    expect(img?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
  });
});
