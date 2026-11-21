// The store tools (tools.js) as a small MCP server, so Demo mode's Claude app
// can call them the same way the API does. The CLI starts it over stdio:
// one JSON-RPC message per line in, one per line out.

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ProductIndex } from "./search.js";
import { TOOLS, runTool } from "./tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let index = null; // loaded on first use, so starting the CLI stays quick
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no reply
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "store", version: "1.0.0" } } });
  }
  if (method === "tools/list") {
    return send({ id, result: { tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema })) } });
  }
  if (method === "tools/call") {
    index ??= new ProductIndex(path.join(here, "..", "data", "catalog.json"));
    const text = runTool(index, params?.name, params?.arguments);
    return send({ id, result: { content: [{ type: "text", text }] } });
  }
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
