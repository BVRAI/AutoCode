// The reviewer tier between "ask" and "bypass" (Phase 5.4): in auto mode a
// risky shell command (the classifier's `confirm` verdict) is judged by a
// cheap model that sees the command, why it was flagged and the user's
// request — never tool results — and either lets it run or hands it to the
// user. Claude Code's auto mode and Codex's Guardian take the same shape.

export interface JudgeInput {
  command: string;
  reason: string;
  task: string;
  projectRoot: string;
}

export interface Judgement {
  decision: 'allow' | 'ask';
  reason: string;
}

export function judgePrompt(input: JudgeInput): { system: string; user: string } {
  return {
    system:
      'You are the safety reviewer for an autonomous coding agent working inside one project directory. ' +
      'A shell command it wants to run was flagged as risky by a pattern check. Decide whether it is safe to run ' +
      'WITHOUT asking the user: allow when the command is a normal, reversible part of software work inside the ' +
      'project (build, test, install, git operations that do not rewrite shared history, file moves inside the ' +
      'project) and clearly serves the request; ask when it could destroy data, touch paths outside the project, ' +
      'change the system, send data somewhere, publish, force-push, or when you are unsure. Reply with JSON only: ' +
      '{"decision":"allow"|"ask","reason":"one sentence"}.',
    user: `Project root: ${input.projectRoot}\nUser's request: ${input.task.slice(0, 1_500)}\n\nFlag: ${input.reason}\nCommand:\n${input.command.slice(0, 2_000)}`,
  };
}

export function parseJudgement(text: string): Judgement {
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
      const decision = obj['decision'] === 'allow' ? 'allow' : 'ask';
      return { decision, reason: typeof obj['reason'] === 'string' ? obj['reason'] : '' };
    } catch {
      /* fall through */
    }
  }
  return { decision: 'ask', reason: 'unparsable judgement' };
}
