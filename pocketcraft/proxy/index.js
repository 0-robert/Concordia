// Concordia Claude proxy.
//
// Thin HTTP proxy in front of the Anthropic API. Holds the API key
// server-side so the host page (and eventually the deployed demo) never
// sees it. Tiny + stateless; no persistence.
//
// The host page POSTs { messages, tools?, system?, model? } and gets back
// Anthropic's raw response (including tool_use blocks).
// The host page orchestrates the tool-use loop and sends each next turn.

const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = Number(process.env.PORT || 3009);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

if (!API_KEY) {
  console.error("[proxy] FATAL: ANTHROPIC_API_KEY not set. Create proxy/.env with it.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("POST only");
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const { messages, tools, system, model, max_tokens } = body;

    if (!Array.isArray(messages)) throw new Error("messages must be array");

    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: max_tokens ?? 1024,
      messages,
    };
    if (system) params.system = system;
    if (tools) params.tools = tools;

    console.log(`[proxy] POST /  msgs=${messages.length}  tools=${tools?.length || 0}`);
    const resp = await anthropic.messages.create(params);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(resp));
  } catch (e) {
    console.error("[proxy] error:", e?.message || e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e?.message || String(e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on :${PORT}  model=${DEFAULT_MODEL}`);
});
