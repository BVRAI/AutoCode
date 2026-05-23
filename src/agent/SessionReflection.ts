// Smart docs — at session end (or on /reflect), ask a small model to look
// at what we just did and propose appendable lines for AUTOCODE.md. The
// user reviews each proposal one at a time and accepts / skips / edits.
// Anthropic's article calls this pattern out as the canonical stop-hook
// example; it's also the first concrete "hook" in autocode and the
// natural foundation for the general hooks framework we'll build next.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderName } from '../llm/Router.js';
import type { LlmRouter } from '../llm/Router.js';
import type { ContentBlock } from '../llm/types.js';

export interface SessionSnapshot {
  userPrompts: string[];          // verbatim user prompts in this session
  assistantReplies: string[];     // assistant text replies (final per turn)
  toolCalls: Array<{ name: string; argsPreview: string }>;
  filesChanged: string[];         // session-scoped union, project-relative paths
}

export interface RawProposal {
  text: string;   // one to three lines suitable for AUTOCODE.md
  scope: string;  // "" for root, otherwise a project-relative directory
  reason: string; // one-sentence rationale shown to the user
}

export interface Proposal extends RawProposal {
  target: string; // absolute path to the AUTOCODE.md the proposal will append to
}

export interface ReflectionDeps {
  router: LlmRouter;
  provider: ProviderName;
  model: string;
  projectRoot: string;
}

// Trigger thresholds — a session that did almost nothing has nothing to
// teach us about the project. Caller (AgentLoop) can also pre-gate.
const MIN_TOOL_CALLS_WHEN_NO_FILE_CHANGES = 3;
const MAX_PROPOSALS = 5;
const MAX_PROPOSAL_TEXT = 400;
const MAX_PROMPT_CHARS = 6000;

const SYSTEM_PROMPT = `You review what an AI coding assistant just did in a project session and propose short, durable notes for AUTOCODE.md — the project-instructions file the assistant reads at the start of every future session.

Your goal: capture the 1–3 things about THIS project that, had they been written in AUTOCODE.md before the session, would have saved time or prevented mistakes. Examples of good proposals:
- "The test command for the agent subsystem is \`pytest -xvs tests/agent/\`."
- "Filenames use kebab-case; source files use PascalCase for class definitions."
- "Never edit \`vendor/\` — it's vendored from upstream."

Bad proposals (do not produce):
- Restating what the model already does well in general.
- Praise / fluff / commentary on the session.
- Anything inferred from one data point that might not generalize.
- Generic coding advice not specific to this project.

Output: JSON only. An array of 0–5 objects, each with keys:
- "text": string. 1–3 lines, plain prose, ≤400 chars. The exact wording that will be appended.
- "scope": string. "" if it applies project-wide, OR a project-relative directory (e.g. "src/agent") if narrower.
- "reason": string. One sentence. Why this is worth knowing next session.

Return [] if nothing in the session was worth recording.`;

// Pure: shape the session into a single user message. Truncates if huge.
export function buildReflectionPrompt(snapshot: SessionSnapshot): string {
  const parts: string[] = [];
  parts.push('## Session summary\n');
  if (snapshot.userPrompts.length > 0) {
    parts.push(`### User prompts (${snapshot.userPrompts.length})`);
    parts.push(snapshot.userPrompts.map((p, i) => `${i + 1}. ${truncate(p, 600)}`).join('\n'));
    parts.push('');
  }
  if (snapshot.assistantReplies.length > 0) {
    parts.push(`### Assistant final replies`);
    parts.push(snapshot.assistantReplies.map((r) => truncate(r, 800)).join('\n---\n'));
    parts.push('');
  }
  if (snapshot.filesChanged.length > 0) {
    parts.push(`### Files changed (${snapshot.filesChanged.length})`);
    parts.push(snapshot.filesChanged.map((p) => `- ${p}`).join('\n'));
    parts.push('');
  }
  if (snapshot.toolCalls.length > 0) {
    parts.push(`### Tool calls (${snapshot.toolCalls.length})`);
    const previews = snapshot.toolCalls
      .map((t) => `- ${t.name}: ${truncate(t.argsPreview, 120)}`)
      .join('\n');
    parts.push(previews);
    parts.push('');
  }
  parts.push(
    'Now produce the JSON array of proposals (or [] if nothing in this session is worth remembering).',
  );
  const joined = parts.join('\n');
  return joined.length <= MAX_PROMPT_CHARS ? joined : joined.slice(0, MAX_PROMPT_CHARS) + '\n…[truncated]';
}

// Pure: extract a JSON array from a model response. Tolerant of markdown
// code fences and leading prose. Returns [] if nothing parses.
export function parseProposals(text: string): RawProposal[] {
  const stripped = text
    .replace(/```json\b/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  const slice = stripped.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawProposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    const scope = typeof o.scope === 'string' ? normalizeScope(o.scope) : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (text.length === 0) continue;
    out.push({
      text: text.slice(0, MAX_PROPOSAL_TEXT),
      scope,
      reason: reason.slice(0, 200),
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

function normalizeScope(s: string): string {
  const cleaned = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  // Reject anything trying to escape the project root.
  if (cleaned === '.' || cleaned === '..' || cleaned.startsWith('../') || cleaned.includes('//')) {
    return '';
  }
  return cleaned;
}

// Decide which AUTOCODE.md a proposal targets. Root scope → <root>/AUTOCODE.md.
// Subtree scope → <root>/<scope>/AUTOCODE.md (created if missing).
export function resolveTarget(proposal: RawProposal, projectRoot: string): string {
  return proposal.scope === ''
    ? join(projectRoot, 'AUTOCODE.md')
    : join(projectRoot, proposal.scope, 'AUTOCODE.md');
}

// Append (or create) the target AUTOCODE.md with a dated section. Never
// overwrites existing content — purely additive.
export function applyProposal(proposal: Proposal): void {
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n\n## (added by autocode on ${date})\n- ${proposal.text.replace(/\r?\n/g, '\n  ')}\n`;
  mkdirSync(dirname(proposal.target), { recursive: true });
  if (existsSync(proposal.target)) {
    appendFileSync(proposal.target, block, 'utf8');
  } else {
    // Start a fresh file with a one-line header so it's a valid AUTOCODE.md
    // out of the gate.
    writeFileSync(
      proposal.target,
      `# AUTOCODE.md\n\nProject conventions for the autocode agent. Edit freely; the agent reads this every session.${block}`,
      'utf8',
    );
  }
}

// Top-level: take a session snapshot, ask the model to reflect, return
// proposals each resolved to a target AUTOCODE.md path. Returns [] on any
// LLM error (failure is silent — reflection is best-effort).
export async function runSessionReflection(
  snapshot: SessionSnapshot,
  deps: ReflectionDeps,
): Promise<Proposal[]> {
  if (
    snapshot.filesChanged.length === 0 &&
    snapshot.toolCalls.length < MIN_TOOL_CALLS_WHEN_NO_FILE_CHANGES
  ) {
    return [];
  }
  const prompt = buildReflectionPrompt(snapshot);
  let text: string;
  try {
    const resp = await deps.router.complete(deps.provider, {
      model: deps.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
    });
    text = resp.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  } catch {
    return [];
  }
  const raw = parseProposals(text);
  return raw.map((p) => ({ ...p, target: resolveTarget(p, deps.projectRoot) }));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
