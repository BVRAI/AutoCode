import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../auth/ConfigStore.js';

const CONNECT_TIMEOUT_MS = 5_000;
// A tool call that runs longer than this is abandoned with a message; MCP
// has no background notion, so the model is told to try a narrower call.
const CALL_TIMEOUT_MS = 120_000;
// ~25k tokens: past this a result only crowds the context (Claude Code's cap).
const OUTPUT_CAP_CHARS = 100_000;

export interface DiscoveredTool {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

export interface DiscoveredResource {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

type Transport = StdioClientTransport | StreamableHTTPClientTransport;

interface ConnectedServer {
  name: string;
  client: Client;
  transport: Transport;
  tools: DiscoveredTool[];
  resources: DiscoveredResource[];
  error?: string;
}

/** `${VAR}` in header values comes from the environment, so tokens stay out of config files. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '');
}

/** Which transport a config describes (pure; tested). */
export function transportKind(config: McpServerConfig): 'stdio' | 'http' {
  if (config.type === 'http' || config.type === 'sse') return 'http';
  if (config.type === 'stdio') return 'stdio';
  return typeof config.url === 'string' && config.url.length > 0 ? 'http' : 'stdio';
}

// Spawns or connects the MCP servers of a session, discovers their tools and
// resources, and provides a single execute() entry point callable by McpTool.
// Failures (server crashes, missing binaries, connect timeouts, bad URLs) are
// soft — they leave that server's `error` set and skip its tools.
export class McpClientManager {
  private servers: ConnectedServer[] = [];

  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(configs);
    const results = await Promise.all(entries.map(([name, config]) => this.connectOne(name, config)));
    // Deterministic order (by server name) so the tool list — part of the
    // cached prompt prefix — is byte-stable across sessions.
    this.servers = results.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<ConnectedServer> {
    const client = new Client({ name: 'autocode', version: '0.2.0' }, { capabilities: {} });
    let transport: Transport;
    try {
      transport = this.transportFor(config);
    } catch (e) {
      const dummy = new StdioClientTransport({ command: process.execPath, args: ['-e', ''] });
      return { name, client, transport: dummy, tools: [], resources: [], error: e instanceof Error ? e.message : String(e) };
    }
    const server: ConnectedServer = { name, client, transport, tools: [], resources: [] };
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS));
      await Promise.race([client.connect(transport), timeout]);
      const listed = await client.listTools();
      server.tools = (listed.tools ?? [])
        .map((t) => ({
          serverName: name,
          toolName: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }))
        .sort((a, b) => a.toolName.localeCompare(b.toolName));
      // Resources are optional on the server side; a refusal is not an error.
      try {
        const res = await client.listResources();
        server.resources = (res.resources ?? []).map((r) => ({
          serverName: name,
          uri: r.uri,
          name: r.name ?? r.uri,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch {
        server.resources = [];
      }
    } catch (e) {
      server.error = e instanceof Error ? e.message : String(e);
      try {
        await transport.close();
      } catch {
        /* ignore cleanup failure */
      }
    }
    return server;
  }

  private transportFor(config: McpServerConfig): Transport {
    if (transportKind(config) === 'http') {
      if (!config.url) throw new Error('http server needs a url');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.headers ?? {})) headers[k] = expandEnv(v);
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    }
    if (!config.command) throw new Error('stdio server needs a command');
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean; truncated?: boolean }> {
    const server = this.servers.find((s) => s.name === serverName);
    if (!server) return { content: `unknown mcp server: ${serverName}`, isError: true };
    if (server.error) return { content: `server ${serverName} failed to connect: ${server.error}`, isError: true };
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${serverName}/${toolName} did not finish within ${CALL_TIMEOUT_MS / 1000}s — try a narrower call`)), CALL_TIMEOUT_MS),
      );
      const result = (await Promise.race([server.client.callTool({ name: toolName, arguments: args }), timeout])) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      let text = (result.content ?? [])
        .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type}]`))
        .join('\n');
      let truncated = false;
      if (text.length > OUTPUT_CAP_CHARS) {
        text = `${text.slice(0, OUTPUT_CAP_CHARS)}\n… [mcp result truncated at ${OUTPUT_CAP_CHARS} chars; ask for less]`;
        truncated = true;
      }
      return { content: text || '(empty result)', isError: Boolean(result.isError), truncated };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  async readResource(serverName: string, uri: string): Promise<{ content: string; isError: boolean }> {
    const server = this.servers.find((s) => s.name === serverName);
    if (!server || server.error) return { content: `server ${serverName} unavailable`, isError: true };
    try {
      const res = await server.client.readResource({ uri });
      const text = (res.contents ?? [])
        .map((c) => (typeof (c as { text?: string }).text === 'string' ? (c as { text: string }).text : `[${(c as { mimeType?: string }).mimeType ?? 'binary'} ${(c as { blob?: string }).blob?.length ?? 0} bytes]`))
        .join('\n');
      return { content: text.length > OUTPUT_CAP_CHARS ? `${text.slice(0, OUTPUT_CAP_CHARS)}\n… [truncated]` : text || '(empty resource)', isError: false };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  discoveredTools(): DiscoveredTool[] {
    return this.servers.flatMap((s) => s.tools);
  }

  discoveredResources(): DiscoveredResource[] {
    return this.servers.flatMap((s) => s.resources);
  }

  status(): Array<{ name: string; connected: boolean; toolCount: number; resourceCount: number; error?: string }> {
    return this.servers.map((s) => ({
      name: s.name,
      connected: !s.error,
      toolCount: s.tools.length,
      resourceCount: s.resources.length,
      error: s.error,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this.servers.map(async (s) => {
        try {
          await s.client.close();
        } catch {
          /* ignore */
        }
        try {
          await s.transport.close();
        } catch {
          /* ignore */
        }
      }),
    );
    this.servers = [];
  }
}
