import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { buildSystemPromptParts } from '../agent/PromptBuilder.js';
import { loadProjectInstructions } from '../agent/ProjectInstructions.js';
import { MemoryStore } from '../agent/Memory.js';
import { ToolRegistry } from '../agent/ToolRegistry.js';
import { gateFor } from '../agent/AgentLoop.js';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';

export interface InspectionRequest {
  version: number;
  projectRoot: string;
  sessionId: string;
  provider: string;
  model: string;
  mode: string;
  locale?: string;
  systemAppendix?: string;
  autoVerify?: boolean;
  verifyCommand?: string;
}

export interface InspectionVerification { autoVerify?: boolean; verifyCommand?: string }

export function inspectLiveSession(ctx: SessionContext, registry: ToolRegistry, verification: InspectionVerification) {
  const names = new Set([...registry.schemas().map(t => t.name), ...registry.deferredNames()]);
  const tools = [...names].sort((a, b) => a.localeCompare(b)).flatMap(name => {
    const tool = registry.get(name);
    return tool ? [{
      ...tool.definition,
      availability: registry.isDeferred(name) ? 'on-demand' : 'loaded',
      modePolicy: gateFor(ctx.mode, name),
    }] : [];
  });
  return {
    version: 1,
    source: 'live',
    generatedAt: new Date().toISOString(),
    context: {
      projectRoot: ctx.projectRoot, sessionId: ctx.sessionId,
      provider: ctx.model.provider, model: ctx.model.model, mode: ctx.mode,
      locale: ctx.locale, systemAppendix: ctx.systemAppendix,
    },
    verification,
    tools,
  };
}

/** Only the short-lived inspection worker may build a preview. Its caches are
 * isolated from every live run; no session, keyring, MCP or provider is created. */
export function buildInspectionPreview(request: InspectionRequest) {
  if (process.env.AUTOCODE_INSPECTION !== '1') throw new Error('Preview requires an isolated inspection worker.');
  if (request?.version !== 1) throw new Error('Unsupported inspection version.');
  if (typeof request.projectRoot !== 'string' || !isAbsolute(request.projectRoot))
    throw new Error('Choose an existing project folder before inspecting.');
  const root = resolve(request.projectRoot);
  try { if (!statSync(root).isDirectory()) throw new Error(); }
  catch { throw new Error('The project folder is missing or cannot be read.'); }
  if (!['planning', 'default', 'autocode', 'admin', 'sights'].includes(request.mode))
    throw new Error('Unsupported AutoCode workflow mode.');
  if (typeof request.provider !== 'string' || !request.provider || typeof request.model !== 'string' || !request.model)
    throw new Error('A provider and model are required for the preview.');
  const ctx: SessionContext = {
    projectRoot: root, sessionId: request.sessionId || 'preview',
    dataDir: '', sessionDir: '', startedAt: new Date().toISOString(),
    model: { provider: request.provider, model: request.model }, mode: request.mode as AgentMode,
    locale: typeof request.locale === 'string' ? request.locale : undefined,
    systemAppendix: typeof request.systemAppendix === 'string' ? request.systemAppendix : undefined,
  };
  const diagnostics: string[] = [];
  const instructions = loadProjectInstructions(root, diagnostics);
  const memory = new MemoryStore(root).list(diagnostics);
  // No query, index startup or live-runtime cache refresh. The UI calls out the
  // missing request-specific retrieval instead of pretending this is a wire log.
  const { system, systemVolatile } = buildSystemPromptParts(ctx);
  const registry = ctx.mode === 'sights' ? ToolRegistry.forSights() : new ToolRegistry();
  return {
    ...inspectLiveSession(ctx, registry, { autoVerify: request.autoVerify, verifyCommand: request.verifyCommand }),
    source: 'preview', instructions, memory, diagnostics, system, systemVolatile,
  };
}
