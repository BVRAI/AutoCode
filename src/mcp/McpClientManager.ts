import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../auth/ConfigStore.js';

const CONNECT_TIMEOUT_MS = 5_000;

export interface DiscoveredTool {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: DiscoveredTool[];
  error?: string;
}

// Spawns + connects MCP servers configured in ~/.autocode/config.json,
// discovers their tools, and provides a single execute() entry point
// callable by McpTool. Failures (server crashes, missing binaries,
// connect timeouts) are soft — they leave that server's `error` set
// and skip its tools, but don't break the session.
export class McpClientManager {
  private servers: ConnectedServer[] = [];

  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(configs);
    const results = await Promise.all(
      entries.map(([name, config]) => this.connectOne(name, config)),
    );
    this.servers = results;
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<ConnectedServer> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
    const client = new Client(
      { name: 'autocode', version: '0.1.0' },
      { capabilities: {} },
    );
    const server: ConnectedServer = { name, client, transport, tools: [] };
    try {
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      );
      await Promise.race([connectPromise, timeoutPromise]);

      const listed = await client.listTools();
      server.tools = (listed.tools ?? []).map((t) => ({
        serverName: name,
        toolName: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
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

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const server = this.servers.find((s) => s.name === serverName);
    if (!server) {
      return { content: `unknown mcp server: ${serverName}`, isError: true };
    }
    if (server.error) {
      return { content: `server ${serverName} failed to connect: ${server.error}`, isError: true };
    }
    try {
      const result = (await server.client.callTool({
        name: toolName,
        arguments: args,
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      const text = (result.content ?? [])
        .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type}]`))
        .join('\n');
      return { content: text || '(empty result)', isError: Boolean(result.isError) };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  discoveredTools(): DiscoveredTool[] {
    return this.servers.flatMap((s) => s.tools);
  }

  status(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }> {
    return this.servers.map((s) => ({
      name: s.name,
      connected: !s.error,
      toolCount: s.tools.length,
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
