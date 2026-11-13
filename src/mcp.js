/**
 * Fisher Poster Voice — a tiny remote MCP server (Streamable HTTP, JSON responses)
 * that lets a Claude artifact page clone a speaker's voice and generate narration
 * through ElevenLabs, without exposing the ElevenLabs API key.
 *
 * Deploy on Cloudflare Workers. Settings → Variables and Secrets:
 *   ELEVENLABS_API_KEY  (secret)  your ElevenLabs key
 *   INVITE_CODES        (secret)  comma-separated invite codes, e.g. "lee-7f3k,fisher-q9x2"
 *   TOKEN_SECRET        (secret)  any long random string (signs voice tokens)
 *   MODEL_ID            (text, optional)  ElevenLabs model, default eleven_multilingual_v2
 *
 * Connector URL for claude.ai (one per invite code):
 *   https://<your-worker>.workers.dev/mcp/<invite-code>
 */

const SERVER_INFO = { name: "fisher-poster-voice", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;   // per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;    // all files together
const MAX_SAMPLES = 5;
const MAX_TEXT_CHARS = 2500;

const TOOLS = [
  {
    name: "create_voice_clone",
    title: "Create voice clone",
    description:
      "Create an ElevenLabs Instant Voice Clone from 1-5 short audio samples of the speaker's own voice " +
      "(compressed, base64-encoded). Requires consent_confirmed=true. Returns a voice_id and a voice_token " +
      "that generate_narration needs.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the voice, e.g. 'Prof. Jane Doe (poster)'." },
        consent_confirmed: { type: "boolean", description: "True only if the uploader is the speaker or has the speaker's explicit permission." },
        remove_background_noise: { type: "boolean", description: "Apply ElevenLabs audio isolation. Only for noisy samples." },
        samples: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SAMPLES,
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              mime_type: { type: "string", description: "e.g. audio/mpeg" },
              data_base64: { type: "string", description: "Base64 audio bytes, at most 10 MB decoded." }
            },
            required: ["filename", "mime_type", "data_base64"]
          }
        }
      },
      required: ["name", "consent_confirmed", "samples"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "generate_narration",
    title: "Generate narration",
    description:
      "Turn one narration script (max 2500 characters) into speech with a voice created by create_voice_clone. " +
      "Returns base64 MP3 (44.1 kHz, 64 kbps).",
    inputSchema: {
      type: "object",
      properties: {
        voice_id: { type: "string" },
        voice_token: { type: "string", description: "The token returned by create_voice_clone for this voice." },
        text: { type: "string", description: "The script to read aloud." },
        stability: { type: "number", minimum: 0, maximum: 1, description: "Default 0.5" },
        similarity_boost: { type: "number", minimum: 0, maximum: 1, description: "Default 0.75" }
      },
      required: ["voice_id", "voice_token", "text"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];

/* ---------------- helpers ---------------- */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolText = (obj, isError = false) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }],
  ...(isError ? { isError: true } : { structuredContent: obj })
});

function codeOk(code, env) {
  const list = String(env.INVITE_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  return code && list.includes(code);
}

function b64ToBytes(b64) {
  const clean = String(b64 || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

const elevenBase = env => (env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, "");

async function elevenError(res) {
  let detail = "";
  try { const j = await res.json(); detail = (j.detail && (j.detail.message || j.detail.status || JSON.stringify(j.detail))) || JSON.stringify(j); }
  catch { try { detail = await res.text(); } catch {} }
  return `ElevenLabs error ${res.status}${detail ? ": " + String(detail).slice(0, 300) : ""}`;
}

/* ---------------- tools ---------------- */
async function createVoiceClone(args, env, inviteCode) {
  if (args.consent_confirmed !== true) return toolText("Consent is required: set consent_confirmed to true only if this is your own voice or you have the speaker's permission.", true);
  const name = String(args.name || "").trim().slice(0, 100);
  if (!name) return toolText("A voice name is required.", true);
  const samples = Array.isArray(args.samples) ? args.samples : [];
  if (samples.length < 1 || samples.length > MAX_SAMPLES) return toolText(`Send between 1 and ${MAX_SAMPLES} samples.`, true);

  const form = new FormData();
  form.append("name", name);
  form.append("description", "Created via Fisher Poster Voice");
  form.append("labels", JSON.stringify({ source: "fisher-poster", invite: inviteCode.slice(0, 24) }));
  if (args.remove_background_noise === true) form.append("remove_background_noise", "true");

  let total = 0;
  for (const [i, s] of samples.entries()) {
    let bytes;
    try { bytes = b64ToBytes(s.data_base64); } catch { return toolText(`Sample ${i + 1} is not valid base64.`, true); }
    if (bytes.length === 0) return toolText(`Sample ${i + 1} is empty.`, true);
    if (bytes.length > MAX_SAMPLE_BYTES) return toolText(`Sample ${i + 1} is larger than 10 MB. Trim or compress it first.`, true);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) return toolText("Samples are larger than 25 MB in total.", true);
    const mime = String(s.mime_type || "audio/mpeg");
    const fname = String(s.filename || `sample-${i + 1}.mp3`).replace(/[^\w.\-]+/g, "_").slice(0, 80);
    form.append("files", new Blob([bytes], { type: mime }), fname);
  }

  const res = await fetch(`${elevenBase(env)}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, accept: "application/json" },
    body: form
  });
  if (!res.ok) return toolText(await elevenError(res), true);
  const data = await res.json();
  if (!data.voice_id) return toolText("ElevenLabs did not return a voice_id.", true);
  const voice_token = await sign(env.TOKEN_SECRET || env.ELEVENLABS_API_KEY, `voice:${data.voice_id}`);
  return toolText({ voice_id: data.voice_id, voice_token, requires_verification: !!data.requires_verification, sample_bytes: total });
}

async function generateNarration(args, env) {
  const voice_id = String(args.voice_id || "");
  if (!/^[A-Za-z0-9]{8,64}$/.test(voice_id)) return toolText("Invalid voice_id.", true);
  const expected = await sign(env.TOKEN_SECRET || env.ELEVENLABS_API_KEY, `voice:${voice_id}`);
  if (String(args.voice_token || "") !== expected) return toolText("This voice can only be used with the token returned when it was created.", true);
  const text = String(args.text || "").trim();
  if (!text) return toolText("The script is empty.", true);
  if (text.length > MAX_TEXT_CHARS) return toolText(`The script is longer than ${MAX_TEXT_CHARS} characters. Split it into shorter parts.`, true);
  const clamp = (v, d) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);

  const res = await fetch(`${elevenBase(env)}/v1/text-to-speech/${voice_id}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: env.MODEL_ID || "eleven_multilingual_v2",
      voice_settings: { stability: clamp(args.stability, 0.5), similarity_boost: clamp(args.similarity_boost, 0.75) }
    })
  });
  if (!res.ok) return toolText(await elevenError(res), true);
  const buf = await res.arrayBuffer();
  return toolText({ mime_type: "audio/mpeg", bytes: buf.byteLength, audio_base64: bytesToB64(buf) });
}

/* ---------------- MCP plumbing ---------------- */
async function handleRpc(msg, env, inviteCode) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request");
  const isNotification = msg.id === undefined || msg.id === null;
  const { method, params = {} } = msg;

  if (method.startsWith("notifications/")) return null;
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Voice tools for building interactive research posters. Only clone a voice with the speaker's consent."
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name, args = params.arguments || {};
      if (!env.ELEVENLABS_API_KEY) return rpcResult(msg.id, toolText("Server is missing ELEVENLABS_API_KEY.", true));
      try {
        if (name === "create_voice_clone") return rpcResult(msg.id, await createVoiceClone(args, env, inviteCode));
        if (name === "generate_narration") return rpcResult(msg.id, await generateNarration(args, env));
        return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      } catch (e) {
        return rpcResult(msg.id, toolText(`Server error: ${e && e.message ? e.message : e}`, true));
      }
    }
    case "resources/list": return rpcResult(msg.id, { resources: [] });
    case "prompts/list": return rpcResult(msg.id, { prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Fisher Poster Voice MCP server is running.\n", { headers: { "content-type": "text/plain" } });
    }
    // Unknown paths and wrong invite codes look identical: 404, so codes can't be probed.
    if (!m || !codeOk(decodeURIComponent(m[1]), env)) return new Response("Not found\n", { status: 404 });
    const inviteCode = decodeURIComponent(m[1]);

    if (request.method === "GET") return new Response("Method not allowed\n", { status: 405, headers: { allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405, headers: { allow: "POST" } });

    let body;
    try { body = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }

    const headers = { "mcp-session-id": request.headers.get("mcp-session-id") || crypto.randomUUID() };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(msg => handleRpc(msg, env, inviteCode)))).filter(Boolean);
      return out.length ? json(out, 200, headers) : new Response(null, { status: 202, headers });
    }
    const out = await handleRpc(body, env, inviteCode);
    return out ? json(out, 200, headers) : new Response(null, { status: 202, headers });
  }
};
