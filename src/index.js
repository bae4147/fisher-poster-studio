/**
 * Fisher Poster Studio — standalone site on Cloudflare Workers.
 *
 * Static pages come from ./public (studio at "/", posters at "/p/<slug>", Hun Lee's poster at "/lee/").
 * This Worker adds the API:
 *   POST /api/auth            {code}            -> sets a signed session cookie for an invite code
 *   GET  /api/me                                -> {ok}
 *   POST /api/draft           (PDF body)        -> OpenAI reads the paper, returns poster JSON
 *   POST /api/voice           (MP3 body)        -> ElevenLabs instant voice clone
 *   POST /api/narrate         {voice, text...}  -> ElevenLabs narration for one section, stored in KV
 *   POST /api/publish         {slug, poster...} -> saves the poster; replaces this invite code's older poster
 *   GET  /api/posters                           -> gallery list
 *   GET  /api/posters/<slug>                    -> one poster (public)
 *   GET  /audio/<slug>/<section>.mp3            -> narration audio (public)
 *   POST /api/chat            {slug, messages}  -> AI version of the author answers from the paper (public)
 *   POST /mcp/<invite-code>                     -> the earlier MCP connector, kept for compatibility
 *
 * Secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, INVITE_CODES, TOKEN_SECRET
 * Vars (wrangler.jsonc): OPENAI_POSTER_MODEL, OPENAI_CHAT_MODEL, OPENAI_REASONING, PDF_DETAIL, MODEL_ID
 * KV binding: POSTERS
 */
import mcp from "./mcp.js";
import { LEE_SYSTEM } from "./lee.js";

const SECTIONS = ["narrative", "findings", "methods", "takeaway"];
const MAX_PDF = 30 * 1024 * 1024;
const MAX_VOICE = 10 * 1024 * 1024;
const MAX_SCRIPT = 2500;
const COOKIE = "fps";

/* ---------------- small helpers ---------------- */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (status, message, code) => json({ error: { message, code: code || "error" } }, status);
const openaiBase = env => (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
const elevenBase = env => (env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, "");
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function requireSecret(env) { if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not set on the server."); return env.TOKEN_SECRET; }
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(requireSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).slice(0, 32);
}
const inviteCodes = env => String(env.INVITE_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
async function session(request, env) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [code64, sig] = decodeURIComponent(m[1]).split(".");
  let code; try { code = atob(code64); } catch { return null; }
  if (!sig || sig !== await hmac(env, "sess:" + code)) return null;
  return inviteCodes(env).includes(code) ? code : null;
}
const codeKey = async (env, code) => "code:" + (await hmac(env, "code:" + code));
const slugMake = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; return [...crypto.getRandomValues(new Uint8Array(10))].map(x => a[x % a.length]).join(""); };

/* Keep slow upstream calls alive: stream a space every 8 s, then the JSON. Clients trim and parse. */
function slowJson(work) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const tick = setInterval(() => w.write(enc.encode(" ")).catch(() => {}), 8000);
  (async () => {
    let out;
    try { out = await work(); } catch (e) { out = { error: { message: String(e && e.message || e), code: e && e.code || "error" } }; }
    clearInterval(tick);
    try { await w.write(enc.encode(JSON.stringify(out))); await w.close(); } catch {}
  })();
  return new Response(readable, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
class UpstreamError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

async function upstreamMessage(res, who) {
  let detail = "";
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || (j.detail && (j.detail.message || j.detail.status)) || JSON.stringify(j); }
  catch { try { detail = await res.text(); } catch {} }
  return `${who} error ${res.status}${detail ? ": " + String(detail).slice(0, 300) : ""}`;
}
function outputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) for (const c of item.content || []) if (c.type === "output_text" && c.text) parts.push(c.text);
  return parts.join("");
}

/* ---------------- poster drafting (OpenAI) ---------------- */
const S = (desc, extra = {}) => ({ type: "string", description: desc, ...extra });
const POSTER_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "authors", "venue", "narrative", "findings", "methods", "takeaway", "scripts", "brief", "suggested_questions"],
  properties: {
    title: S("The paper's title"),
    authors: { type: "array", items: S("Author name"), description: "Authors in order" },
    venue: S("Journal or outlet, year, volume/article info if present"),
    narrative: { type: "object", additionalProperties: false, required: ["headline", "paragraphs"], properties: {
      headline: S("One-sentence hook, max 22 words"),
      paragraphs: { type: "array", items: S("35-60 words"), description: "Exactly 2 short paragraphs: the question and why it matters; the theoretical idea" } } },
    findings: { type: "object", additionalProperties: false, required: ["headline", "points", "stats"], properties: {
      headline: S("Main result in one sentence, max 22 words"),
      points: { type: "array", items: S("Max 28 words, plain language"), description: "3-4 key findings" },
      stats: { type: "array", description: "2-4 numbers that appear in the paper", items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: {
        value: S("A short number or ratio exactly as reported, e.g. 4/4, .59, 524"), label: S("What it is, max 9 words") } } } } },
    methods: { type: "object", additionalProperties: false, required: ["studies", "note"], properties: {
      studies: { type: "array", description: "1-4 items (group extra studies)", items: { type: "object", additionalProperties: false, required: ["name", "detail", "tag"], properties: {
        name: S("e.g. Study 1 · Field survey"), detail: S("Sample, design, setting in max 30 words"), tag: S("2-3 word design label") } } },
      note: S("One sentence on why this design, max 30 words") } },
    takeaway: { type: "object", additionalProperties: false, required: ["headline", "tips"], properties: {
      headline: S("The practical lesson in one sentence, max 18 words"),
      tips: { type: "array", description: "Exactly 3", items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: S("2-5 words"), text: S("Max 24 words") } } } } },
    scripts: { type: "object", additionalProperties: false, required: SECTIONS, properties: Object.fromEntries(SECTIONS.map(k => [k, S("Narration script for the " + k + " panel, 130-165 words")])) },
    brief: S("A factual digest for a Q&A assistant, 450-900 words"),
    suggested_questions: { type: "array", items: S("Max 9 words"), description: "4 short questions a curious visitor might ask" }
  }
};
const posterSystem = spoken => `You turn a published research paper into the content of an interactive, conference-style poster for a general audience (students and members of the public). The presenter is the paper's author, who introduces themself as "${spoken}".

Accuracy rules:
- Use ONLY facts stated in the attached paper. Read tables and figures as well as the text.
- Copy numbers exactly as the paper reports them. Do not round, invent, or infer results, samples, or quotes.
- If a hypothesis was not supported or a result did not replicate, say so plainly.

Content rules:
- methods.studies: 1-4 items, grouping extra studies. takeaway.tips: exactly 3. findings.stats: 2-4 items, only numbers that appear in the paper.
- brief: research question, theory, hypotheses and which were supported, every study's sample and design, key numbers, boundary conditions, limitations, future directions, practical implications.

Narration scripts (read aloud by an AI voice of the author, about 55-65 seconds each, 130-165 words):
- First person, warm and conversational, the author speaking to a visitor at their poster ("we found", "in our second study").
- scripts.narrative must start with "Hi, I'm ${spoken}, and thanks for stopping by."
- Write every number as words a speaker would say (for example "five hundred twenty-four", "point five nine").
- No symbols, abbreviations, parentheses, citations, or statistics notation. Do not invent personal anecdotes.`;

async function uploadPdf(env, bytes, filename) {
  const fd = new FormData();
  fd.append("purpose", "user_data");
  fd.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
  const res = await fetch(`${openaiBase(env)}/v1/files`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI (file upload)"), "upstream");
  return (await res.json()).id;
}
async function draftPoster(env, fileId, spoken) {
  const body = {
    model: env.OPENAI_POSTER_MODEL || "gpt-6.1-sol",
    reasoning: { effort: env.OPENAI_REASONING || "medium" },
    input: [
      { role: "system", content: posterSystem(spoken) },
      { role: "user", content: [
        { type: "input_file", file_id: fileId, detail: env.PDF_DETAIL || "low" },
        { type: "input_text", text: "Create the poster content for this paper." } ] } ],
    text: { format: { type: "json_schema", name: "poster", strict: true, schema: POSTER_SCHEMA } }
  };
  const res = await fetch(`${openaiBase(env)}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI"), "upstream");
  const data = await res.json();
  const text = outputText(data);
  if (!text) throw new UpstreamError("OpenAI returned no poster" + (data.status ? " (status " + data.status + ")" : ""), "upstream");
  return cleanPoster(JSON.parse(text));
}
function cleanPoster(j) {
  const St = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 600);
  const A = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];
  const p = {
    title: St(j.title, 300), authors: A(j.authors, 20).map(x => St(x, 80)).filter(Boolean), venue: St(j.venue, 200),
    narrative: { headline: St(j.narrative?.headline, 240), paragraphs: A(j.narrative?.paragraphs, 3).map(x => St(x, 600)).filter(Boolean) },
    findings: { headline: St(j.findings?.headline, 240), points: A(j.findings?.points, 5).map(x => St(x, 300)).filter(Boolean),
      stats: A(j.findings?.stats, 4).map(s => ({ value: St(s?.value, 16), label: St(s?.label, 90) })).filter(s => s.value) },
    methods: { studies: A(j.methods?.studies, 4).map(s => ({ name: St(s?.name, 60), detail: St(s?.detail, 320), tag: St(s?.tag, 40) })).filter(s => s.name || s.detail), note: St(j.methods?.note, 300) },
    takeaway: { headline: St(j.takeaway?.headline, 200), tips: A(j.takeaway?.tips, 3).map(t => ({ title: St(t?.title, 60), text: St(t?.text, 260) })).filter(t => t.title || t.text) },
    scripts: Object.fromEntries(SECTIONS.map(k => [k, St(j.scripts?.[k], MAX_SCRIPT)])),
    brief: St(j.brief, 9000), suggested: A(j.suggested_questions || j.suggested, 4).map(x => St(x, 80)).filter(Boolean)
  };
  if (!p.title || !p.narrative.headline || !SECTIONS.every(k => p.scripts[k].length > 60)) throw new UpstreamError("The draft came back incomplete. Please try again.", "incomplete");
  return p;
}

/* ---------------- voice (ElevenLabs) ---------------- */
async function cloneVoice(env, bytes, name) {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("description", "Created via Fisher Poster Studio");
  fd.append("files", new Blob([bytes], { type: "audio/mpeg" }), "voice-sample.mp3");
  const res = await fetch(`${elevenBase(env)}/v1/voices/add`, { method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, accept: "application/json" }, body: fd });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "ElevenLabs"), "upstream");
  const data = await res.json();
  if (!data.voice_id) throw new UpstreamError("ElevenLabs did not return a voice.", "upstream");
  return data.voice_id;
}
async function tts(env, voiceId, text) {
  const res = await fetch(`${elevenBase(env)}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: env.MODEL_ID || "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "ElevenLabs"), "upstream");
  return res.arrayBuffer();
}

/* ---------------- chat ---------------- */
function chatSystem(v) {
  return `You are an AI version of ${v.displayName}, created with their consent, standing at the poster for their paper (summarized below) on an interactive web poster about Fisher College of Business faculty research. Visitors are students and members of the public. Speak in the first person as the author ("we found", "in our second study").
Speaking style: warm, clear and conversational, like a professor talking a curious visitor through their poster. Explain ideas with simple examples before giving numbers.
Rules:
- Content comes only from the paper summary below. If it does not cover something, say it is beyond what this paper tested instead of guessing.
- Do not invent personal stories, opinions, future projects, or facts about the author's life, other work, or co-authors beyond what is below. If asked about those, say you would rather keep the conversation on this study.
- If someone sincerely asks whether you are really ${v.displayName}, say plainly that you are an AI version of them built from the paper.
- Be accurate about what was and was not supported.
- Keep answers short: 2 to 5 sentences in plain language, giving numbers only when they help. Plain text, no markdown headings or bullet symbols.
- Reply in the language the visitor writes in.
- For off-topic requests, briefly steer back to the study.

PAPER: ${v.poster.title}. ${v.poster.authors.join(", ")}. ${v.poster.venue}.
SUMMARY:
${v.poster.brief}`;
}
async function chat(env, system, messages) {
  const body = {
    model: env.OPENAI_CHAT_MODEL || "gpt-6-luna",
    max_output_tokens: 600,
    input: [{ role: "system", content: system }, ...messages]
  };
  const res = await fetch(`${openaiBase(env)}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI"), "upstream");
  return outputText(await res.json()).trim();
}

/* ---------------- routes ---------------- */
async function api(request, env, url) {
  const p = url.pathname, method = request.method;

  if (p === "/api/auth" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch {}
    const code = String(body.code || "").trim();
    if (!code || !inviteCodes(env).includes(code)) return err(401, "That invite code isn't valid.", "bad_code");
    const val = encodeURIComponent(btoa(code) + "." + await hmac(env, "sess:" + code));
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}` });
  }
  if (p === "/api/me") {
    const code = await session(request, env);
    let mine = null;
    if (code) { const slug = await env.POSTERS.get(await codeKey(env, code)); if (slug) { const v = await env.POSTERS.get("poster:" + slug, "json"); if (v) mine = { slug, title: v.poster.title }; } }
    return json({ ok: !!code, mine });
  }
  if (p === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });

  if (p === "/api/posters" && method === "GET") {
    const list = await env.POSTERS.list({ prefix: "poster:" });
    const items = list.keys.map(k => ({ slug: k.name.slice(7), ...(k.metadata || {}) })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ posters: items });
  }
  let m = p.match(/^\/api\/posters\/([a-z0-9]{6,20})$/);
  if (m && method === "GET") {
    const v = await env.POSTERS.get("poster:" + m[1], "json");
    if (!v) return err(404, "Poster not found.", "not_found");
    const { brief, ...pub } = v.poster;
    return json({ slug: m[1], displayName: v.displayName, spokenName: v.spokenName, createdAt: v.createdAt, audio: v.audio, poster: pub });
  }

  if (p === "/api/chat" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch {}
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
      .filter(x => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string")
      .map(x => ({ role: x.role, content: x.content.slice(0, 1500) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return err(400, "Ask a question first.", "bad_request");
    let system;
    if (body.slug === "lee") system = LEE_SYSTEM;
    else { const v = await env.POSTERS.get("poster:" + String(body.slug || ""), "json"); if (!v) return err(404, "Poster not found.", "not_found"); system = chatSystem(v); }
    try { return json({ text: await chat(env, system, msgs) }); }
    catch (e) { return err(502, "The chat is unavailable right now.", "upstream"); }
  }

  /* --- everything below needs an invite code session --- */
  const code = await session(request, env);
  if (!code) return err(401, "Please enter your invite code again.", "no_session");

  if (p === "/api/draft" && method === "POST") {
    const spoken = String(url.searchParams.get("spoken") || "").trim().slice(0, 60);
    const fname = (String(url.searchParams.get("filename") || "paper.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 80)) || "paper.pdf";
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return err(400, "No PDF received.", "bad_request");
    if (bytes.byteLength > MAX_PDF) return err(413, "That PDF is larger than 30 MB.", "too_large");
    if (!spoken) return err(400, "Name is missing.", "bad_request");
    return slowJson(async () => {
      const fileId = await uploadPdf(env, bytes, fname);
      try { return { poster: await draftPoster(env, fileId, spoken) }; }
      finally { fetch(`${openaiBase(env)}/v1/files/${fileId}`, { method: "DELETE", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } }).catch(() => {}); }
    });
  }

  if (p === "/api/voice" && method === "POST") {
    if (request.headers.get("x-consent") !== "yes") return err(400, "Consent is required.", "no_consent");
    const name = String(request.headers.get("x-name") || "").trim().slice(0, 80);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return err(400, "No voice sample received.", "bad_request");
    if (bytes.byteLength > MAX_VOICE) return err(413, "The voice sample is larger than 10 MB. Trim it and try again.", "too_large");
    return slowJson(async () => {
      const voice_id = await cloneVoice(env, bytes, (name || "Fisher presenter") + " (Fisher poster)");
      return { voice_id, voice_token: await hmac(env, "voice:" + voice_id), slug: slugMake() };
    });
  }

  if (p === "/api/narrate" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const { voice_id, voice_token, slug, section } = b; const text = String(b.text || "").trim();
    if (!/^[A-Za-z0-9]{8,64}$/.test(voice_id || "") || voice_token !== await hmac(env, "voice:" + voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    if (!/^[a-z0-9]{6,20}$/.test(slug || "") || !SECTIONS.includes(section)) return err(400, "Bad request.", "bad_request");
    if (!text || text.length > MAX_SCRIPT) return err(400, "The script is empty or too long.", "bad_request");
    return slowJson(async () => {
      const audio = await tts(env, voice_id, text);
      await env.POSTERS.put(`audio:${slug}:${section}`, audio, { metadata: { bytes: audio.byteLength } });
      return { ok: true, bytes: audio.byteLength };
    });
  }

  if (p === "/api/publish" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const slug = String(b.slug || "");
    if (!/^[a-z0-9]{6,20}$/.test(slug)) return err(400, "Bad request.", "bad_request");
    if (b.voice_token !== await hmac(env, "voice:" + b.voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    let poster; try { poster = cleanPoster(b.poster || {}); } catch (e) { return err(400, e.message, "bad_poster"); }
    const displayName = String(b.displayName || "").trim().slice(0, 80), spokenName = String(b.spokenName || "").trim().slice(0, 60);
    if (!displayName) return err(400, "Name is missing.", "bad_request");
    for (const k of SECTIONS) if (!(await env.POSTERS.get(`audio:${slug}:${k}`, "arrayBuffer"))) return err(400, "Narration for " + k + " is missing. Build again.", "missing_audio");
    const createdAt = Date.now();
    await env.POSTERS.put("poster:" + slug, JSON.stringify({ displayName, spokenName, createdAt, poster, audio: SECTIONS }), { metadata: { title: poster.title.slice(0, 200), displayName, createdAt } });
    const ck = await codeKey(env, code), old = await env.POSTERS.get(ck);
    await env.POSTERS.put(ck, slug);
    if (old && old !== slug) { await env.POSTERS.delete("poster:" + old); for (const k of SECTIONS) await env.POSTERS.delete(`audio:${old}:${k}`); }
    return json({ ok: true, slug, url: new URL("/p/" + slug, url).toString() });
  }

  return err(404, "Not found.", "not_found");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), p = url.pathname;
    try {
      if (p.startsWith("/mcp/") || p === "/health") return mcp.fetch(request, env, ctx);
      if (p.startsWith("/api/")) return await api(request, env, url);
      let m = p.match(/^\/audio\/([a-z0-9]{6,20})\/(narrative|findings|methods|takeaway)\.mp3$/);
      if (m) {
        const buf = await env.POSTERS.get(`audio:${m[1]}:${m[2]}`, "arrayBuffer");
        if (!buf) return new Response("Not found", { status: 404 });
        return new Response(buf, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "accept-ranges": "none" } });
      }
      if (/^\/p\/[a-z0-9]{6,20}\/?$/.test(p)) { const r = await env.ASSETS.fetch(new Request(new URL("/poster", url), { method: "GET", headers: request.headers })); return new Response(r.body, { status: r.status, headers: r.headers }); }
      if (p === "/lee") return Response.redirect(new URL("/lee/", url).toString(), 301);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return err(500, "Server error: " + String(e && e.message || e), "server");
    }
  }
};
