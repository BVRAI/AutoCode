// Built-in skills — compiled into autocode and merged at the lowest
// precedence in Skills.discoverSkills(). They follow the same progressive-
// disclosure contract as on-disk skills: only the name + description sit in
// the system prompt (one line each), and the body is pulled in on demand via
// the `use_skill` tool. A user- or project-defined skill of the same name
// overrides the built-in.
//
// Keep the bodies tight — they're meant to encode conventions the model
// can't infer, not to restate git's manual.

import type { Skill } from './Skills.js';

// Version-control conventions. Surfaced only in git repos (PromptBuilder
// drops it elsewhere). Encodes the project's settled decisions: commit only
// when asked, the autocode co-author trailer, branch+PR over committing to
// the default branch, gh for PRs, and destructive-op guardrails.
const GIT_SKILL_BODY = `# Working with git

Run git and \`gh\` through the \`run_shell\` tool — there is no separate git tool. The system prompt already carries the live working state (branch, staged/modified/untracked files, recent commits), so you usually don't need \`git status\` just to orient.

## Commits
- Commit ONLY when the user explicitly asks (e.g. "commit", "save this", "make a commit"). Never auto-commit after finishing an edit, and never commit to the default branch (main/master) unless the user asked you to.
- Before committing, review what will be included: \`git diff\` for unstaged work, \`git diff --staged\` for what's staged. Stage deliberately with \`git add <paths>\` rather than \`git add -A\` when only some changes are relevant.
- Write a concise, imperative subject (~50 chars), e.g. \`fix(auth): correct login redirect\`. Add a short body only when the "why" isn't obvious from the subject.
- Append this trailer to commits you create, so AI-assisted commits are transparent:

      Co-Authored-By: Autocode <noreply@bvrai.ca>

## Branches & pull requests
- Prefer a feature branch over committing straight to the default branch: \`git switch -c <name>\`.
- Open PRs with the GitHub CLI when it's available: \`gh pr create --fill\` (or pass an explicit title/body). Read state with \`gh pr view\`, \`gh pr checks\`, \`gh issue view\`. Prefer \`gh\` over raw GitHub API calls — it's more context-efficient.

## Inspecting history (on demand)
- \`git log --oneline -n 20\`, \`git log -p <path>\`, \`git show <sha>\`, \`git blame <path>\`, \`git diff <a>..<b>\`. Pull only what the task needs — don't dump large histories into the conversation.

## Destructive operations — confirm first
- Never run \`git push --force\`/\`-f\`, \`git reset --hard\`, \`git clean -f\`, or \`git branch -D\` without the user's explicit go-ahead (the safety policy will also prompt). Offer the safe alternative when you can — \`git revert\` instead of \`reset --hard\`, \`--force-with-lease\` instead of \`--force\`.
`;

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'git',
    description:
      'Version-control conventions — when/how to commit (only when asked), branch + PR workflow, gh usage, inspecting history, and destructive-op guardrails. Load when doing git work.',
    body: GIT_SKILL_BODY,
    source: 'builtin',
  },
];
