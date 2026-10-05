// Offline stand-in for the Claude Code CLI used by claude-code-runtime tests.
// Usage: node claude-code-fake-cli.mjs <scenario> ...claude args
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [scenario, ...args] = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) =>
  emit({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  });
const result = (extra = {}) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
    ...extra,
  });

if (scenario === "probe") {
  if (args[0] === "--version") process.stdout.write("2.1.0 (Claude Code)\n");
  else if (args[0] === "auth") {
    process.stdout.write(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    );
  }
  process.exit(0);
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextUser = async () => {
  const next = await lines.next();
  return next.done ? undefined : JSON.parse(next.value);
};
const userText = (message) =>
  message.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

async function tools() {
  const config = JSON.parse(flag("--mcp-config")).mcpServers.rakazo;
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }),
  );
  return client;
}

emit({ type: "system", subtype: "init", model: "claude-test-1", tools: [] });
const first = await nextUser();

if (scenario === "text") {
  text("Hello ");
  text("there");
  result();
} else if (scenario === "echo-prompt") {
  text(userText(first));
  result();
} else if (scenario === "tool") {
  const client = await tools();
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).join(",");
  const called = await client.callTool({
    name: "echo",
    arguments: { word: "kiwi" },
    _meta: { "claudecode/toolUseId": "toolu_1" },
  });
  text(`tools=${names}; result=${called.content[0].text}`);
  result();
} else if (scenario === "ask") {
  const client = await tools();
  await client.callTool({
    name: "ask_user",
    arguments: { question: "Which?", options: ["A", "B"] },
  });
  await new Promise(() => undefined);
} else if (scenario === "signed-out") {
  result({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
} else if (scenario === "steer") {
  text("first");
  result();
  const second = await nextUser();
  text(` then ${userText(second)}`);
  result();
} else if (scenario === "hang") {
  await new Promise(() => undefined);
}

while (await nextUser()) {
  // Hold the session open until the runtime closes stdin, as the real CLI does.
}
process.exit(0);
