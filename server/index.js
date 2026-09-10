import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const PORT = Number(process.env.PORT || 8787);
const RUNWARE_URL = "https://api.runware.ai/v1";

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "80mb" }));

function apiKey() {
  return (process.env.RUNWARE_API_KEY || "").trim();
}

function openRouterKey() {
  return (process.env.OPENROUTER_API_KEY || "").trim();
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(apiKey()),
    grok: Boolean(openRouterKey()),
    provider: "runware",
  });
});

app.post("/api/enhance", async (req, res) => {
  const key = openRouterKey();
  if (!key) {
    res.status(500).json({
      error: "missingOpenRouterKey",
      message: "OPENROUTER_API_KEY is not set on the server.",
    });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: "invalidBody", message: "Request body must include messages." });
    return;
  }

  try {
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/srican1982/seedream-studio",
        "X-Title": "Seedream Studio",
      },
      body: JSON.stringify({
        model: body.model || "x-ai/grok-4.6",
        messages: body.messages,
        stream: false,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1024,
        provider: body.provider || { order: ["x-ai"], allow_fallbacks: false },
      }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenRouter request failed";
    res.status(502).json({ error: "upstreamError", message });
  }
});

app.post("/api/runware", async (req, res) => {
  const key = apiKey();
  if (!key) {
    res.status(500).json({
      errors: [
        {
          code: "missingApiKey",
          message: "RUNWARE_API_KEY is not set on the server.",
        },
      ],
    });
    return;
  }

  const tasks = req.body;
  if (!Array.isArray(tasks)) {
    res.status(400).json({
      errors: [{ code: "invalidBody", message: "Request body must be a task array." }],
    });
    return;
  }

  try {
    const upstream = await fetch(RUNWARE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream request failed";
    res.status(502).json({
      errors: [{ code: "upstreamError", message }],
    });
  }
});

app.get("/api/media", async (req, res) => {
  const key = apiKey();
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url || !/^https:\/\/([\w.-]+\.)?runware\.ai\//i.test(url)) {
    res.status(400).json({ errors: [{ code: "invalidUrl", message: "Blocked media URL." }] });
    return;
  }

  try {
    const headers = {};
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const upstream = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({
        errors: [{ code: "mediaFetchFailed", message: `Media fetch failed (${upstream.status}).` }],
      });
      return;
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media fetch failed";
    res.status(502).json({ errors: [{ code: "mediaFetchFailed", message }] });
  }
});

app.use(express.static(dist));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) {
    next();
    return;
  }
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Seedream Studio → http://localhost:${PORT}`);
});
