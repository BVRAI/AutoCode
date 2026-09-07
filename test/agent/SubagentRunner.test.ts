// The subagent loop's last iteration is answer-only: no tools, plus a notice
// asking for the verdict/list. A model that would otherwise explore until the
// cap still ends with a parsable answer.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentRunner, finalIterationNotice } from '../../src/agent/SubagentRunner.js';
import type { LlmRouter } from '../../src/llm/Router.js';
import type { CompletionRequest, CompletionResponse } from '../../src/llm/types.js';
import type { TranscriptStore } from '../../src/session/TranscriptStore.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function parent(root: string): SessionContext {
  return {
    sessionId: 's',
    projectRoot: root,
    dataDir: join(root, 'data'),
    sessionDir: join(root, 'session'),
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
}

describe('SubagentRunner final iteration', () => {
  it('strips tools on the last iteration, sends the notice, and returns the model\'s answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-subagent-'));
    try {
      const requests: CompletionRequest[] = [];
      const router = {
        complete: async (_provider: string, req: CompletionRequest): Promise<CompletionResponse> => {
          requests.push(req);
          const usage = { inputTokens: 10, outputTokens: 5 };
          if (req.tools.length === 0) {
            return { content: [{ type: 'text', text: '{"verdict":"approve","findings":[]}' }], stopReason: 'end_turn', usage };
          }
          return {
            content: [{ type: 'tool_use', id: `t${requests.length}`, name: 'read_file', input: { path: `missing-${requests.length}.txt` } }],
            stopReason: 'tool_use',
            usage,
          };
        },
      } as unknown as LlmRouter;
      const store = { appendToolLog: () => undefined } as unknown as TranscriptStore;
      const runner = new SubagentRunner(router, store);
      const result = await runner.run({ type: 'Review', prompt: 'review the diff', description: 'review', parentDepth: 0, parent: parent(root) });

      const last = requests[requests.length - 1]!;
      expect(last.tools).toEqual([]);
      // The runner keeps appending to the shared messages array after the
      // call, so look at the last USER message the final request carried.
      const userMsgs = last.messages.filter((m) => m.role === 'user');
      const lastUser = userMsgs[userMsgs.length - 1]!;
      const text = Array.isArray(lastUser.content) ? lastUser.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : String(lastUser.content);
      expect(text).toContain(finalIterationNotice('Review'));
      expect(requests.slice(0, -1).every((r) => r.tools.length > 0)).toBe(true);
      expect(result.text).toContain('"verdict":"approve"');
      expect(result.error).toBeUndefined();
      expect(result.iterations).toBe(requests.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('phrases the notice per contract', () => {
    expect(finalIterationNotice('Review')).toMatch(/JSON only/);
    expect(finalIterationNotice('Localize')).toMatch(/ranked candidates/);
    expect(finalIterationNotice('Explore')).toMatch(/final answer/);
  });
});
