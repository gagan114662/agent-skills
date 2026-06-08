#!/usr/bin/env node
// Minimal MCP client used by the #10 demo (scripts/demos/10-mcp.sh). Connects to the Reload MCP
// server over Streamable HTTP with an agent Bearer token and drives the documented flow. Run from
// the @reload/server package so the official SDK resolves from its node_modules.
//
//   MCP_URL=http://localhost:3000/mcp RELOAD_TOKEN=rld_agt_… node scripts/mcp-demo-client.mjs act  <writeCh> <readCh>
//   MCP_URL=… RELOAD_TOKEN=…                                   node scripts/mcp-demo-client.mjs watch
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const URL_ = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const TOKEN = process.env.RELOAD_TOKEN ?? "";
const [, , command, writeCh, readCh] = process.argv;

const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

async function connect() {
  const transport = new StreamableHTTPClientTransport(new global.URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "reload-demo", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function act() {
  const client = await connect();
  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  const channels = await client.callTool({ name: "list_channels", arguments: {} });
  console.log("list_channels →", text(channels));

  const posted = await client.callTool({
    name: "post_message",
    arguments: { channelId: writeCh, body: "scout online via MCP" },
  });
  console.log("post_message (write channel) → ok:", !posted.isError);

  const denied = await client.callTool({
    name: "post_message",
    arguments: { channelId: readCh, body: "should be blocked" },
  });
  console.log("post_message (read-only channel) → isError:", denied.isError, "|", text(denied));

  await client.close();
}

async function watch() {
  const client = await connect();
  let got = null;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
    if (n.params.uri === "reload://mentions" && !got) {
      const res = await client.readResource({ uri: "reload://mentions" });
      got = JSON.parse(res.contents[0].text);
    }
  });
  await client.subscribeResource({ uri: "reload://mentions" });
  console.log("READY"); // the demo posts an @mention once it sees this line
  const start = Date.now();
  while (!got && Date.now() - start < 10000) await new Promise((r) => setTimeout(r, 50));
  if (got?.length) console.log("PUSHED mention →", got[0].body);
  else console.log("no mention received within 10s");
  await client.close();
}

await (command === "watch" ? watch() : act());
process.exit(0);
