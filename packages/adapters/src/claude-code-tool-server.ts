import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { CLAUDE_CODE_TOOL_SERVER, CLAUDE_CODE_TOOL_TIMEOUT_MS } from "./claude-code-cli.js";

export type ClaudeCodeToolCall = (
  name: string,
  args: Record<string, unknown>,
  toolUseId: string | undefined,
) => Promise<CallToolResult>;

export interface ClaudeCodeToolServer {
  /** Value for `--mcp-config`. Holds a per-run bearer, so it is never logged. */
  mcpConfig: string;
  close(): Promise<void>;
}

/**
 * Serves one run's Rakazo tools to the spawned CLI over loopback MCP. The
 * listener binds 127.0.0.1 only and every request must carry the run's random
 * bearer and a loopback Host header, so other local processes and rebinding
 * pages cannot call the bot's tools.
 */
export async function startClaudeCodeToolServer(
  tools: ConnectorTool[],
  call: ClaudeCodeToolCall,
): Promise<ClaudeCodeToolServer> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const mcp = new Server(
    { name: CLAUDE_CODE_TOOL_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", ...tool.inputSchema } as {
        type: "object";
        [key: string]: unknown;
      },
    })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!byName.has(name)) {
      return { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true };
    }
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const toolUseId = meta?.["claudecode/toolUseId"];
    return call(
      name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      typeof toolUseId === "string" ? toolUseId : undefined,
    );
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);

  let port = 0;
  const http = createServer((req, res) => {
    if (!authorized(req, expected, port)) {
      res.writeHead(401).end();
      return;
    }
    transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  port = (http.address() as AddressInfo).port;

  return {
    mcpConfig: JSON.stringify({
      mcpServers: {
        [CLAUDE_CODE_TOOL_SERVER]: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
          timeout: CLAUDE_CODE_TOOL_TIMEOUT_MS,
        },
      },
    }),
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await mcp.close().catch(() => undefined);
    },
  };
}

function authorized(req: IncomingMessage, expected: Buffer, port: number): boolean {
  if (req.headers.host !== `127.0.0.1:${port}`) return false;
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
