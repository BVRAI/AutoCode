import type { SessionContext } from '../session/SessionContext.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';
import type { AgentHandler } from './TerminalMode.js';
import { buildAgentInput } from '../util/imageInput.js';

// Non-interactive mode: submit a single prompt, run it to completion, exit.
// Used by `acv1 -p "<prompt>"`. Reuses the full agent stack — only the REPL
// loop is replaced. Returns a process exit code.
export async function runHeadless(
  agent: AgentHandler,
  renderer: ConsoleRenderer,
  ctx: SessionContext,
  prompt: string,
): Promise<number> {
  try {
    const { input, missing } = buildAgentInput(prompt, ctx.projectRoot);
    for (const ref of missing) renderer.warn(`(could not read image: ${ref})`);
    await agent.submit(input, ctx);
    return 0;
  } catch (e) {
    renderer.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
