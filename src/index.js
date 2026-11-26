/**
 * Fisher Poster Studio — standalone site on Cloudflare Workers.
 *
 * Static pages come from ./public (studio at "/", posters at "/p/<slug>", Hun Lee's poster at "/lee/").
 * This Worker adds the API:
 *   GET  /api/me                                -> {ok, mine} and a signed per-browser owner cookie
 *   GET  /api/status                            -> which server settings are present (no values)
 *   POST /api/draft           (PDF body)        -> OpenAI reads the paper, returns poster JSON
 *   POST /api/figure          (image body) -> stores a figure cropped from the paper
 *   POST /api/voice           (audio body: the original file, WAV or MP3) -> ElevenLabs instant voice clone
 *   POST /api/narrate         {voice, text...}  -> ElevenLabs narration for one section, stored in KV
 *   POST /api/publish         {slug, poster...} -> saves the poster under a new permanent link (older posters are kept);
 *                                                  then deletes the voice clone from ElevenLabs
 *   POST /api/voice/discard   {voice, token}    -> deletes a voice clone after a failed build
 *   GET  /api/posters                           -> gallery list
 *   GET  /api/posters/<slug>                    -> one poster (public)
 *   GET  /audio/<slug>/<section>.mp3            -> narration audio (public)
 *   POST /api/chat            {slug, messages}  -> AI version of the author answers from the paper (public)
 *   POST /mcp/<invite-code>                     -> the earlier MCP connector, kept for compatibility
 *
 * Secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, TOKEN_SECRET, ADMIN_CODE (for /admin.html host characters) (INVITE_CODES is only used by /mcp/)
 * Vars (wrangler.jsonc): OPENAI_POSTER_MODEL, OPENAI_CHAT_MODEL, OPENAI_REASONING, PDF_DETAIL, MODEL_ID, DAILY_BUILD_LIMIT
 * KV binding: POSTERS
 */
import mcp from "./mcp.js";
import { LEE_SYSTEM } from "./lee.js";

const SECTIONS = ["introduction", "motivation", "narrative", "findings", "methods", "takeaway"];
const SHORT_SECTIONS = ["introduction", "motivation"];
const MAX_NOTE = 1500; // author-written introduction / motivation text
const MAX_PDF = 30 * 1024 * 1024;
const FIGURE_PANELS = ["narrative", "findings", "methods"];   // panels that can show a figure cropped from the paper
const MAX_FIGURE = 4 * 1024 * 1024, MAX_REQUEST = 2000;
const MAX_VOICE = 10 * 1024 * 1024;
const MAX_SCRIPT = 2500;
const MAX_POD_LINES = 32, MAX_POD_LINE = 700;
/* Podcast hosts. Faculty hosts use voice clones already in the ElevenLabs account (IDs set in wrangler.jsonc),
   made with the professors' consent. AC hosts by default; when AC is the author, Hun Whee Lee hosts.
   If the needed voice ID is not set, the stock AI host is used. */
const HOSTS = {
  ac: { name: "Aravind Chandrasekaran", voiceVar: "HOST_AC_VOICE_ID", faculty: true },
  hun: { name: "Hun Whee Lee", voiceVar: "HOST_HUN_VOICE_ID", faculty: true },
  stock: { name: "Jordan", voiceVar: null, faculty: false }
};
const isAC = (...names) => names.some(n => /chandrasekaran/i.test(String(n || "")));
function chooseHost(env, ...authorNames) {
  const k = isAC(...authorNames) ? "hun" : "ac";
  return env[HOSTS[k].voiceVar] ? k : "stock";
}
/* Testing switch (wrangler.jsonc var KEEP_VOICE_CLONES = "true"): keep voice clones in ElevenLabs instead of deleting them. */
const keepClones = env => String(env.KEEP_VOICE_CLONES || "").toLowerCase() === "true";
const COOKIE = "fpo";

/* ---------------- small helpers ---------------- */
/* Secrets pasted into the dashboard often carry a trailing newline, spaces or quotes;
   any of those makes fetch() reject the header ("Invalid header value"). Clean them once. */
const clean = v => String(v == null ? "" : v).replace(/[\s\u200b\ufeff]+/g, "").replace(/^["']+|["']+$/g, "");
const KEYS = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "TOKEN_SECRET"];
function cleanEnv(env) { const e = Object.create(env); for (const k of KEYS) if (env[k] != null) e[k] = clean(env[k]); return e; }
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
/* Each browser gets a signed owner id, so rebuilding replaces that browser's earlier poster. */
async function owner(request, env) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [id, sig] = decodeURIComponent(m[1]).split(".");
  if (!/^[a-z0-9]{16,40}$/.test(id || "") || !sig || sig !== await hmac(env, "owner:" + id)) return null;
  return id;
}
async function ownerCookie(env, id) {
  return `${COOKIE}=${encodeURIComponent(id + "." + await hmac(env, "owner:" + id))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
}
const ownerKey = id => "owner:" + id;
/* Older records stored a single slug; newer ones store a JSON list. */
const ownedSlugs = raw => { if (!raw) return []; try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.filter(x => /^[a-z0-9]{6,20}$/.test(x)); } catch {} return /^[a-z0-9]{6,20}$/.test(raw) ? [raw] : []; };
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
const ICONS = ["🏥","🩺","💊","❤️","🧠","👥","🤝","💬","🗣️","📈","📉","📊","🔁","⚙️","🔧","🧪","🔬","📋","⏱️","📅","🎯","💡","⚖️","🧭","🏭","💼","🏢","🌱","🔍","❓","⚠️","✅","🛡️","💰","🧮","🖥️","🤖","📚","🎓","🏠","🧩","🔗","🙏","😟","😊","🌍","🚀","⭐"];
const ICON = (desc = "An icon that fits") => ({ type: "string", enum: ICONS, description: desc });
const LINE = { type: "array", items: S("One plain sentence, max 25 words"), description: "Exactly 1 sentence" };
const NODE = { type: "object", additionalProperties: false, required: ["label", "sign"], properties: {
  label: S("Construct name, 1-4 plain words"), sign: { type: "string", enum: ["+", "-", ""], description: "Direction of its effect on the next box to the right (for moderators: how it changes the link); empty if not stated" } } };
const POSTER_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "authors", "venue", "introduction", "motivation", "narrative", "findings", "methods", "takeaway", "scripts", "podcast", "brief", "suggested_questions"],
  properties: {
    title: S("The paper's title"),
    authors: { type: "array", items: S("Author name"), description: "Authors in order" },
    venue: S("Journal or outlet, year, volume/article info if present"),
    introduction: { type: "object", additionalProperties: false, required: ["role", "bio", "tags"], description: "ABOUT THE AUTHOR card: introduces the presenting author as a person, not the paper. Use only what the author wrote about themselves and author information printed in the paper; never invent titles, positions, history, awards or interests.", properties: {
      role: S("The author's title and affiliation, e.g. 'Professor of Operations, Fisher College of Business'. Only as stated by the author or the paper's affiliation line; empty string if unknown. Max 14 words"),
      bio: S("1-2 short sentences about who the author is and what they study, max 35 words, third person. Only from the author's own text or an author bio printed in the paper; if neither exists, one sentence saying they are an author of this paper at their stated affiliation"),
      tags: { type: "array", items: S("Research area, 1-3 words"), description: "0-3 research areas the author named or the paper's author bio states; empty if none stated" } } },
    motivation: { type: "object", additionalProperties: false, required: ["icon", "headline", "paragraphs"], properties: {
      icon: ICON(), headline: S("Why this matters, max 15 words"), paragraphs: { ...LINE, description: "Exactly 1 sentence: the problem or gap, and the question the paper asks" } } },
    narrative: { type: "object", additionalProperties: false, required: ["icon", "headline", "paragraphs", "model"], properties: {
      icon: ICON(), headline: S("The core idea, max 15 words"), paragraphs: { ...LINE, description: "Exactly 1 sentence: what we predicted and why" },
      model: { type: "object", additionalProperties: false, required: ["predictors", "mediators", "outcomes", "moderators"], description: "The paper's research model as a left-to-right diagram, using only constructs the paper names", properties: {
        predictors: { type: "array", items: NODE, description: "1-3 starting constructs (causes, interventions, conditions)" },
        mediators: { type: "array", items: NODE, description: "0-2 mechanisms in between; empty if none" },
        outcomes: { type: "array", items: NODE, description: "1-3 outcomes (sign empty)" },
        moderators: { type: "array", items: NODE, description: "0-2 conditions that change the effect; empty if none" } } } } },
    findings: { type: "object", additionalProperties: false, required: ["icon", "headline", "points", "stats", "chart"], properties: {
      icon: ICON(), headline: S("Main result, max 15 words"),
      points: { type: "array", description: "Exactly 3 key findings", items: { type: "object", additionalProperties: false, required: ["icon", "text"], properties: { icon: ICON(), text: S("Max 12 words, plain language") } } },
      stats: { type: "array", description: "2-3 numbers that appear in the paper", items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: {
        value: S("A short number or ratio exactly as reported, e.g. 4/4, .59, 524"), label: S("What it is, max 6 words") } } },
      chart: { type: "object", additionalProperties: false, required: ["title", "bars"], description: "A simple bar chart comparing values the paper reports in the same unit (e.g., treatment vs. control, scenario A vs. B). Leave bars empty if the paper has no such comparison.", properties: {
        title: S("What the bars compare, with the unit, max 10 words"),
        bars: { type: "array", description: "0 or 2-5 bars", items: { type: "object", additionalProperties: false, required: ["label", "value", "shown"], properties: {
          label: S("Bar label, max 4 words"), value: { type: "number", description: "The value as a number, for bar length" }, shown: S("The value exactly as reported, e.g. 3.42, 18%") } } } } } } },
    methods: { type: "object", additionalProperties: false, required: ["icon", "studies"], properties: {
      icon: ICON(),
      studies: { type: "array", description: "1-3 steps or studies in order (group extra studies)", items: { type: "object", additionalProperties: false, required: ["icon", "name", "detail", "tag"], properties: {
        icon: ICON(), name: S("e.g. Study 1 · Field survey, max 5 words"), detail: S("Sample or setting, max 15 words"), tag: S("2-3 word design label") } } } } },
    takeaway: { type: "object", additionalProperties: false, required: ["icon", "headline", "tips"], properties: {
      icon: ICON(), headline: S("The practical lesson, max 12 words"),
      tips: { type: "array", description: "Exactly 3", items: { type: "object", additionalProperties: false, required: ["icon", "title", "text"], properties: { icon: ICON(), title: S("2-3 words"), text: S("Max 10 words") } } } } },
    scripts: { type: "object", additionalProperties: false, required: SECTIONS, properties: Object.fromEntries(SECTIONS.map(k => [k, S("Narration script for the " + k + " panel, " + (SHORT_SECTIONS.includes(k) ? "70-100" : "130-165") + " words")])) },
    podcast: { type: "object", additionalProperties: false, required: ["lines"], description: "A 3-minute two-person podcast conversation about the paper", properties: {
      lines: { type: "array", description: "20-30 conversational turns between host and guest, 420-480 words in total", items: { type: "object", additionalProperties: false, required: ["speaker", "text", "section"], properties: {
        speaker: { type: "string", enum: ["host", "guest"] },
        text: S("What this speaker says in this turn, 2-60 words"),
        section: { type: "string", enum: [...SECTIONS, ""], description: "The poster panel this turn is mainly about, so the poster can zoom to it; empty for greetings and small talk" } } } } } },
    brief: S("A factual digest for a Q&A assistant, 450-900 words"),
    suggested_questions: { type: "array", items: S("Max 9 words"), description: "4 short questions a curious visitor might ask" }
  }
};
const posterSystem = (spoken, hostKey = "stock") => { const H = HOSTS[hostKey] || HOSTS.stock; return `You turn a published research paper into the content of an interactive, conference-style poster for a general audience (students and members of the public). The presenter is the paper's author, who introduces themself as "${spoken}".

Accuracy rules:
- Use ONLY facts stated in the attached paper. Read tables and figures as well as the text.
- Copy numbers exactly as the paper reports them. Do not round, invent, or infer results, samples, or quotes.
- If a hypothesis was not supported or a result did not replicate, say so plainly.

Plain-language rules (apply to all written text on the poster, the model diagram labels, the narration scripts, the podcast and suggested questions; these matter most for the sentences and scripts):
- Write for a curious visitor with no research training, at about a high-school reading level. Short sentences, everyday words.
- Do not use statistical or methods jargon such as "conditional indirect effect", "moderated mediation", "mediation", "moderation", "interaction effect", "main effect", "simple slope", "coefficient", "beta", "variance", "standard deviation", "statistically significant", "p-value", "confidence interval", "construct", "operationalized", "latent", "endogeneity", "multilevel", "within-person". Say what the result means in everyday terms instead, for example "this only happened for leaders who..." rather than "a conditional indirect effect", or "the effect was stronger when..." rather than "a positive interaction".
- Use everyday names for the paper's variables (e.g. "how much people trust their boss" rather than "supervisor-focused trust") unless the paper's term is already common.
- If a technical term truly cannot be avoided, explain it in plain words in the same sentence.
- Numbers: the poster's number elements (findings.stats and findings.chart) may show the paper's key numbers exactly as reported, each with a short plain-language label saying what it means. In sentences, narration and the podcast, describe results in plain words and only mention numbers that help (sample sizes, percentages, simple comparisons), never test statistics or coefficients.

Content rules:
- The panels run in this order and must not repeat each other: introduction (ABOUT THE AUTHOR: who the presenting author is), motivation (why the topic matters, what was missing, and the research question), narrative (theory and predictions), findings, methods, takeaway.
- introduction is about the person, not the paper. Facts about the author come only from the author's own text and author information printed in the paper (affiliation line, author bio). Never guess or embellish a title, position, history, award or research interest.
- The poster is visual: keep on-screen text very short and respect every word limit. The narration scripts carry the explanation, so the panels need only the gist.
- methods.studies: 1-3 items, grouping extra studies. takeaway.tips: exactly 3. findings.points: exactly 3. findings.stats: 2-3 items, only numbers that appear in the paper.
- narrative.model: draw the model the paper actually tests, using its constructs in plain words. If the study has no clear causal model (for example a simulation), show its main drivers and outcomes.
- findings.chart: only values the paper reports, in one shared unit. If there is no clean comparison, return an empty bars array rather than forcing one.
- Choose icons that make each item easy to recognize at a glance.
- brief: research question, theory, hypotheses and which were supported, every study's sample and design, key numbers, boundary conditions, limitations, future directions, practical implications.

Narration scripts (read aloud by an AI voice of the author; introduction and motivation 70-100 words, about 30-40 seconds; the other four 130-165 words, about 55-65 seconds):
- First person, warm and conversational, the author speaking to a visitor at their poster ("we found", "in our second study").
- scripts.introduction must start with "Hi, I'm ${spoken}, and thanks for stopping by." It introduces the author (role, what they study) using only the facts allowed for the introduction panel, then leads briefly into the paper's topic. If little is known about the author, keep that part to one sentence. The other scripts continue the talk without greeting again.
- Write every number as words a speaker would say (for example "five hundred twenty-four", "point five nine").
- No symbols, abbreviations, parentheses, citations, or statistics notation. Do not invent personal anecdotes.

Podcast (about 3 minutes, 420-480 words in total):
- Two speakers: the host, ${H.faculty ? H.name + ", a Fisher College of Business faculty colleague who hosts these research conversations and is curious, warm and new to this paper" : H.name + ", a curious, warm interviewer for Fisher College of Business research conversations"}; and the guest, ${spoken}, the author.${H.faculty ? `
- The host is a real person speaking through an AI voice. Keep the host to reactions, questions, restatements and everyday illustrations. The host does not describe their own research, experiences, opinions or anything else about themselves, and does not praise or evaluate the guest's work beyond brief natural reactions. The host may introduce themself by name in the welcome.` : ""}
- The first turn is the host: one short welcome sentence that names the guest, then exactly this question: "What made you or the research team think about this question?"
- The guest answers using only the motivation the paper states and anything the author wrote in their own notes. Do not invent personal stories, conversations or experiences.
- Make it sound like two people actually talking, not an interview form. Avoid a rigid pattern of host question, guest answer, host question:
  - The host mostly reacts and builds on what the guest just said: restates it in everyday words ("So basically..."), checks their understanding, offers a relatable everyday situation the idea applies to, or pushes back gently ("But wouldn't...?"). Only some host turns are questions.
  - Include short back-and-forth beats: brief reactions ("Huh.", "Right, right.", "Oh, interesting."), the guest picking up the host's example, and the occasional turn where a speaker finishes the other's thought.
  - Vary turn length: some turns are 2-6 words, most are 10-35, and only a few guest turns run to about 60.
  - Let the topic flow by association (the idea, how it was studied, what was found, what to do with it), without announcing sections or saying "first", "second", "great question", or "let's move on".
  - The guest speaks for the team ("we", "our team"), may mention co-authors by name, and explains with simple examples.
- The host's everyday examples must be framed as illustrations, not as facts from the study; every fact about the study must come from the paper.
- Tag each turn with the poster panel it is mainly about (introduction = the author as a person, motivation, narrative, findings, methods, takeaway), or leave it empty for greetings, short reactions and the goodbye.
- End with a light, natural wrap-up and the host thanking the guest. Same rules as narration: numbers written as spoken words, no symbols, abbreviations, stage directions or sound tags.

Author's own notes:
- The author may supply their own text about themselves (for the introduction / about-the-author panel) or for the motivation panel. When they do, build that panel and its script from their text: keep their meaning and as much of their wording as fits, trimming only for length and clarity. Personal reasons or context the author wrote may be used, but add nothing personal beyond what they wrote.
- Facts about the study in their notes must still agree with the paper; if they conflict, follow the paper.
- When a panel has no author text, draft it from the paper.`; };

async function uploadPdf(env, bytes, filename) {
  const fd = new FormData();
  fd.append("purpose", "user_data");
  fd.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
  const res = await fetch(`${openaiBase(env)}/v1/files`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI (file upload)"), "upstream");
  return (await res.json()).id;
}
function notesText(notes) {
  const parts = [];
  if (notes.introduction) parts.push("The author's own text ABOUT THEMSELVES, for the ABOUT THE AUTHOR (introduction) panel:\n<<<\n" + notes.introduction + "\n>>>");
  if (notes.motivation) parts.push("The author's own text for the MOTIVATION panel:\n<<<\n" + notes.motivation + "\n>>>");
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}
async function draftPoster(env, fileId, spoken, notes = {}, hostKey = "stock") {
  const body = {
    model: env.OPENAI_POSTER_MODEL || "gpt-6.1-sol",
    reasoning: { effort: env.OPENAI_REASONING || "medium" },
    input: [
      { role: "system", content: posterSystem(spoken, hostKey) },
      { role: "user", content: [
        { type: "input_file", file_id: fileId, detail: env.PDF_DETAIL || "low" },
        { type: "input_text", text: "Create the poster content for this paper." + notesText(notes) } ] } ],
    text: { format: { type: "json_schema", name: "poster", strict: true, schema: POSTER_SCHEMA } }
  };
  const res = await fetch(`${openaiBase(env)}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI"), "upstream");
  const data = await res.json();
  const text = outputText(data);
  if (!text) throw new UpstreamError("OpenAI returned no poster" + (data.status ? " (status " + data.status + ")" : ""), "upstream");
  return cleanPoster(JSON.parse(text), hostKey);
}
function cleanPoster(j, hostKey) {
  hostKey = HOSTS[hostKey] ? hostKey : (HOSTS[j?.podcast?.hostKey] ? j.podcast.hostKey : "stock");
  const St = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 600);
  const A = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];
  const Ic = v => ICONS.includes(v) ? v : "";
  const Sg = v => v === "+" || v === "-" ? v : "";
  const nodes = (v, n) => A(v, n).map(x => ({ label: St(x?.label, 50), sign: Sg(x?.sign) })).filter(x => x.label);
  const text = (o, n) => ({ icon: Ic(o?.icon), headline: St(o?.headline, 240), paragraphs: A(o?.paragraphs, n).map(x => St(x, 600)).filter(Boolean) });
  const m = j.narrative?.model || {};
  let bars = A(j.findings?.chart?.bars, 5).map(b => ({ label: St(b?.label, 40), value: Number(b?.value), shown: St(b?.shown, 20) })).filter(b => b.label && Number.isFinite(b.value) && b.value >= 0);
  if (bars.length < 2) bars = [];
  const p = {
    title: St(j.title, 300), authors: A(j.authors, 20).map(x => St(x, 80)).filter(Boolean), venue: St(j.venue, 200),
    introduction: { role: St(j.introduction?.role, 140), bio: St(j.introduction?.bio, 400), tags: A(j.introduction?.tags, 5).map(x => St(x, 40)).filter(Boolean) },
    motivation: text(j.motivation, 2),
    narrative: { ...text(j.narrative, 3), model: { predictors: nodes(m.predictors, 3), mediators: nodes(m.mediators, 2), outcomes: nodes(m.outcomes, 3), moderators: nodes(m.moderators, 2) } },
    findings: { icon: Ic(j.findings?.icon), headline: St(j.findings?.headline, 240),
      points: A(j.findings?.points, 6).map(x => typeof x === "string" ? { icon: "", text: St(x, 300) } : { icon: Ic(x?.icon), text: St(x?.text, 300) }).filter(x => x.text),
      stats: A(j.findings?.stats, 5).map(s => ({ value: St(s?.value, 16), label: St(s?.label, 90) })).filter(s => s.value),
      chart: { title: St(j.findings?.chart?.title, 120), bars } },
    methods: { icon: Ic(j.methods?.icon), studies: A(j.methods?.studies, 5).map(s => ({ icon: Ic(s?.icon), name: St(s?.name, 60), detail: St(s?.detail, 320), tag: St(s?.tag, 40) })).filter(s => s.name || s.detail), note: St(j.methods?.note, 300) },
    takeaway: { icon: Ic(j.takeaway?.icon), headline: St(j.takeaway?.headline, 200), tips: A(j.takeaway?.tips, 6).map(t => ({ icon: Ic(t?.icon), title: St(t?.title, 60), text: St(t?.text, 260) })).filter(t => t.title || t.text) },
    scripts: Object.fromEntries(SECTIONS.map(k => [k, St(j.scripts?.[k], MAX_SCRIPT)])),
    podcast: { host: HOSTS[hostKey].name, hostKey, lines: A(j.podcast?.lines, MAX_POD_LINES).map(l => ({ speaker: l?.speaker === "host" ? "host" : "guest", text: St(l?.text, MAX_POD_LINE), section: SECTIONS.includes(l?.section) ? l.section : "" })).filter(l => l.text) },
    figures: Object.fromEntries(FIGURE_PANELS.filter(k => j.figures && j.figures[k]).map(k => [k, { caption: St(j.figures[k].caption, 200) }])),
    brief: St(j.brief, 9000), suggested: A(j.suggested_questions || j.suggested, 4).map(x => St(x, 80)).filter(Boolean)
  };
  if (!p.title || !p.motivation.headline || !p.narrative.headline || !SECTIONS.every(k => p.scripts[k].length > 60)) throw new UpstreamError("The draft came back incomplete. Please try again.", "incomplete");
  return p;
}

/* ---------------- voice (ElevenLabs) ---------------- */
const SAMPLE_EXT = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
  "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac", "audio/x-flac": "flac" };
async function cloneVoice(env, bytes, name, type = "audio/mpeg") {
  if (!SAMPLE_EXT[type]) type = "audio/mpeg";
  const fd = new FormData();
  fd.append("name", name);
  fd.append("description", "Created via Fisher Poster Studio");
  fd.append("labels", JSON.stringify({ language: "en" }));   // a tag only: the accent comes from the sample itself
  fd.append("files", new Blob([bytes], { type }), "voice-sample." + SAMPLE_EXT[type]);
  const res = await fetch(`${elevenBase(env)}/v1/voices/add`, { method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, accept: "application/json" }, body: fd });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "ElevenLabs"), "upstream");
  const data = await res.json();
  if (!data.voice_id) throw new UpstreamError("ElevenLabs did not return a voice.", "upstream");
  return data.voice_id;
}
async function deleteVoice(env, voiceId) {
  try {
    const res = await fetch(`${elevenBase(env)}/v1/voices/${voiceId}`, { method: "DELETE", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
    return res.ok || res.status === 404;
  } catch { return false; }
}
/* Cloned voices keep the speaker's own accent better with high similarity and speaker boost.
   ctx.model overrides the model (per-host setting); models that accept a language code are told it is English. */
const LANG_CODE_MODELS = /^(eleven_turbo_v2_5|eleven_flash_v2_5|eleven_v3)/;
/* Consistency across a poster's recordings:
   - a fixed seed per poster (ctx.seed) so generations vary less;
   - request stitching (ctx.prev_ids): ElevenLabs continues from the earlier recordings in the same voice;
   - previous_text / next_text only when there is nothing to stitch to. */
const STITCH_MODELS = /^(eleven_multilingual_v2|eleven_turbo_v2_5|eleven_flash_v2_5|eleven_turbo_v2|eleven_flash_v2)$/;
const seedFor = slug => { let h = 2166136261; for (const c of String(slug || "")) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) % 4294967295; };
async function tts(env, voiceId, text, ctx = {}) {
  const model = ctx.model || env.MODEL_ID || "eleven_multilingual_v2";
  const ids = (Array.isArray(ctx.prev_ids) ? ctx.prev_ids : []).filter(x => /^[\w-]{6,80}$/.test(String(x))).slice(-3);
  const stitch = ids.length && STITCH_MODELS.test(model);
  const res = await fetch(`${elevenBase(env)}/v1/text-to-speech/${voiceId}?output_format=${/^mp3_\d+_\d+$/.test(env.OUTPUT_FORMAT || "") ? env.OUTPUT_FORMAT : "mp3_44100_128"}`, {   // 128 kbps, like files downloaded from the ElevenLabs website
    method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model,
      voice_settings: { stability: Number(ctx.stability ?? env.VOICE_STABILITY ?? 0.7), similarity_boost: Number(ctx.similarity ?? env.VOICE_SIMILARITY ?? 0.9), use_speaker_boost: true },
      ...(LANG_CODE_MODELS.test(model) ? { language_code: "en" } : {}),
      ...(Number.isInteger(ctx.seed) ? { seed: ctx.seed } : {}),
      ...(stitch ? { previous_request_ids: ids } : {}),
      ...(!stitch && ctx.previous_text && STITCH_MODELS.test(model) ? { previous_text: ctx.previous_text.slice(-600) } : {}),
      ...(!stitch && ctx.next_text && STITCH_MODELS.test(model) ? { next_text: ctx.next_text.slice(0, 600) } : {}) })   // context text only on models that take it (not v3)
  });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "ElevenLabs"), "upstream");
  if (ctx.meta) ctx.meta.requestId = res.headers.get("request-id") || "";
  return res.arrayBuffer();
}

/* The podcast host speaks in a stock ElevenLabs voice. Stock voices differ between accounts,
   so use HOST_VOICE_ID if it works, otherwise pick a premade voice this account has (never a clone). */
async function hostVoice(env, refresh = false) {
  if (!refresh) {
    const cached = await env.POSTERS.get("host_voice");
    if (cached) return cached;
    if (env.HOST_VOICE_ID) return env.HOST_VOICE_ID;
  }
  const res = await fetch(`${elevenBase(env)}/v1/voices`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY, accept: "application/json" } });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "ElevenLabs (voice list)"), "upstream");
  const voices = ((await res.json()).voices || []).filter(v => v && v.voice_id && v.category !== "cloned" && !/Fisher Poster Studio/.test(v.description || ""));
  const prefer = ["Sarah", "Jessica", "Laura", "Alice", "Matilda", "River", "Brian", "Eric", "Chris", "Daniel", "Liam", "Will"];
  const pick = voices.filter(v => v.category === "premade").sort((a, b) => {
    const ia = prefer.findIndex(n => (a.name || "").startsWith(n)), ib = prefer.findIndex(n => (b.name || "").startsWith(n));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0] || voices[0];
  if (!pick) throw new UpstreamError("No stock ElevenLabs voice is available for the podcast host. Add one in ElevenLabs (Voices → Voice Library) and try again.", "no_host_voice");
  await env.POSTERS.put("host_voice", pick.voice_id, { expirationTtl: 60 * 60 * 24 * 7 });
  return pick.voice_id;
}

/* ---------------- simple pixel character from a photo ----------------
   A vision call reads a few visible traits (skin tone, hair, glasses, facial hair, clothing); the page then
   assembles a 16 x 16 sprite from fixed parts (public/lib/sprite.js). The photo itself is never stored. */
const MAX_PHOTO = 8 * 1024 * 1024;
const HAIR_STYLES = ["short", "side_part", "spiky", "curly", "medium", "long", "bun", "buzz", "bald"];
const TOPS = ["suit_tie", "suit", "shirt", "sweater", "blouse", "tshirt"];
const LOOK_SCHEMA = { type: "object", additionalProperties: false, required: ["skin", "hair_color", "hair_style", "glasses", "facial_hair", "top", "top_color", "tie_color"], properties: {
  skin: S("Skin tone as a hex color like #b07a55"), hair_color: S("Hair color as a hex color"),
  hair_style: { type: "string", enum: HAIR_STYLES }, glasses: { type: "string", enum: ["none", "clear", "dark"] },
  facial_hair: { type: "string", enum: ["none", "stubble", "mustache", "beard"] },
  top: { type: "string", enum: TOPS }, top_color: S("Main clothing color as hex (jacket if wearing one)"), tie_color: S("Tie color as hex, or #000000 if no tie") } };
/* AC's look, read from the photo he provided; used until a host character is saved from /admin.html */
const BUILTIN_HOST_LOOKS = { ac: { skin: "#b07a55", hair_color: "#1b1b1f", hair_style: "side_part", glasses: "none", facial_hair: "none", top: "suit_tie", top_color: "#1f1f26", tie_color: "#c45a6a" } };
function cleanLook(j) {
  const hex = (v, d) => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v) : d;
  return { skin: hex(j?.skin, "#c98f62"), hair_color: hex(j?.hair_color, "#2b2b2b"),
    hair_style: HAIR_STYLES.includes(j?.hair_style) ? j.hair_style : "short",
    glasses: ["none", "clear", "dark"].includes(j?.glasses) ? j.glasses : "none",
    facial_hair: ["none", "stubble", "mustache", "beard"].includes(j?.facial_hair) ? j.facial_hair : "none",
    top: TOPS.includes(j?.top) ? j.top : "shirt", top_color: hex(j?.top_color, "#2e4a7a"), tie_color: hex(j?.tie_color, "#c2410c") };
}
async function describeLook(env, bytes, type) {
  let bin = ""; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode(...u.subarray(i, i + 32768));
  const body = {
    model: env.OPENAI_LOOK_MODEL || env.OPENAI_CHAT_MODEL || "gpt-6-luna",
    input: [{ role: "user", content: [
      { type: "input_text", text: "Describe this person's visible appearance so a very simple 16x16 pixel-art character can be drawn of them. Report only what the photo clearly shows: choose glasses or facial hair only if they are plainly visible. Colors as hex codes sampled from the photo." },
      { type: "input_image", image_url: `data:${type};base64,${btoa(bin)}`, detail: "low" } ] }],
    text: { format: { type: "json_schema", name: "look", strict: true, schema: LOOK_SCHEMA } }
  };
  const res = await fetch(`${openaiBase(env)}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new UpstreamError(await upstreamMessage(res, "OpenAI (photo)"), "upstream");
  return cleanLook(JSON.parse(outputText(await res.json())));
}
async function readPhoto(request) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return { error: err(400, "Please use a JPG, PNG or WebP photo.", "bad_photo") };
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return { error: err(400, "The photo is empty.", "bad_photo") };
  if (bytes.byteLength > MAX_PHOTO) return { error: err(413, "The photo is larger than 8 MB.", "too_large") };
  return { bytes, type };
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
- Keep answers short: 2 to 5 sentences in plain language, giving numbers only when they help. Avoid statistical jargon (for example "conditional indirect effect", "moderation", "coefficient", "significant"); explain results in everyday words, and only use a technical term if the visitor asks for it, explaining it as you go. Plain text, no markdown headings or bullet symbols.
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

  if (p === "/api/status") {
    return json({ openai: !!env.OPENAI_API_KEY, elevenlabs: !!env.ELEVENLABS_API_KEY, token: !!env.TOKEN_SECRET, storage: !!env.POSTERS, keepVoices: keepClones(env) });
  }
  if (p === "/api/me") {
    let id = await owner(request, env), headers = {};
    if (!id) { id = slugMake() + slugMake(); headers["set-cookie"] = await ownerCookie(env, id); }
    const mine = [];
    for (const slug of ownedSlugs(await env.POSTERS.get(ownerKey(id))).slice(0, 30)) {
      const v = await env.POSTERS.get("poster:" + slug, "json");
      if (v) mine.push({ slug, title: v.poster.title, displayName: v.displayName });
    }
    return json({ ok: true, mine }, 200, headers);
  }

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
    return json({ slug: m[1], displayName: v.displayName, spokenName: v.spokenName, createdAt: v.createdAt, audio: v.audio, audioVer: v.audioVer || {}, podcast: v.podcast || 0, avatar: !!v.avatar, hasVoice: !!v.voiceId, poster: pub });
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

  /* --- building: needs this browser's owner cookie (set by /api/me) --- */
  const ownerId = await owner(request, env);
  if (!ownerId) return err(401, "Please reload the page and try again.", "no_session");

  if (p === "/api/draft" && method === "POST") {
    const spoken = String(url.searchParams.get("spoken") || "").trim().slice(0, 60);
    /* OpenAI decides the file type from the extension, so always send a plain name ending in lowercase .pdf */
    const base = String(url.searchParams.get("filename") || "paper").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9_\- ]+/g, "_").replace(/^[_\s]+|[_\s]+$/g, "").slice(0, 60);
    const fname = (base || "paper") + ".pdf";
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return err(400, "No PDF received.", "bad_request");
    if (bytes.byteLength > MAX_PDF) return err(413, "That PDF is larger than 30 MB.", "too_large");
    const head = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)));
    if (!head.includes("%PDF-")) return err(400, "That file is not a PDF. If you saved it from a library or journal page, open the downloaded file to check it is the paper itself, then try again.", "not_pdf");
    if (!spoken) return err(400, "Name is missing.", "bad_request");
    const note = h => { let t = ""; try { t = decodeURIComponent(request.headers.get(h) || ""); } catch {} return t.replace(/\r/g, "").trim().slice(0, MAX_NOTE); };
    const notes = { introduction: note("x-introduction"), motivation: note("x-motivation") };
    const day = "count:" + new Date().toISOString().slice(0, 10), limit = parseInt(env.DAILY_BUILD_LIMIT || "20", 10);
    const used = parseInt(await env.POSTERS.get(day) || "0", 10);
    if (used >= limit) return err(429, "The studio has reached today's limit of " + limit + " posters. Please try again tomorrow.", "daily_limit");
    await env.POSTERS.put(day, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    return slowJson(async () => {
      const fileId = await uploadPdf(env, bytes, fname);
      const display = String(url.searchParams.get("display") || "").slice(0, 80);
      try { return { poster: await draftPoster(env, fileId, spoken, notes, chooseHost(env, spoken, display)) }; }
      finally { fetch(`${openaiBase(env)}/v1/files/${fileId}`, { method: "DELETE", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } }).catch(() => {}); }
    });
  }

  /* editing a finished poster: the browser that made it, or anyone with the ADMIN_CODE secret */
  const canEdit = async slug => (env.ADMIN_CODE && (request.headers.get("x-admin-code") || "") === env.ADMIN_CODE) || ownedSlugs(await env.POSTERS.get(ownerKey(ownerId))).includes(slug);

  /* save edits to a finished poster (text, icons, items, figures). Audio is not re-recorded, so scripts and podcast stay as they are. */
  if (p === "/api/poster-update" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const slug = String(b.slug || "");
    if (!/^[a-z0-9]{6,20}$/.test(slug)) return err(400, "Bad request.", "bad_request");
    const v = await env.POSTERS.get("poster:" + slug, "json");
    if (!v) return err(404, "Poster not found.", "not_found");
    if (!(await canEdit(slug))) return err(403, "Only the browser that made this poster, or the admin code, can edit it.", "not_owner");
    const old = v.poster;
    let poster;
    try { poster = cleanPoster({ ...(b.poster || {}), scripts: old.scripts, podcast: old.podcast, brief: old.brief, suggested: old.suggested }, old.podcast && old.podcast.hostKey); }
    catch (e) { return err(400, "This poster was made with an older version of the studio and can't be edited here.", "old_poster"); }
    for (const k of Object.keys(poster.figures)) if (!(await env.POSTERS.get(`figure:${slug}:${k}`, "stream"))) delete poster.figures[k];
    v.poster = poster; v.updatedAt = Date.now();
    await env.POSTERS.put("poster:" + slug, JSON.stringify(v), { metadata: { title: poster.title.slice(0, 200), displayName: v.displayName, createdAt: v.createdAt } });
    return json({ ok: true, slug });
  }

  /* feedback from the review screen: what authors wanted to change but couldn't */
  if (p === "/api/feedback" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const text = String(b.text || "").trim().slice(0, 2000);
    if (!text) return err(400, "Please write your feedback first.", "bad_request");
    const day = "fbcount:" + new Date().toISOString().slice(0, 10), used = parseInt(await env.POSTERS.get(day) || "0", 10);
    if (used >= 200) return err(429, "Too much feedback today. Please try again tomorrow.", "daily_limit");
    await env.POSTERS.put(day, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    const rec = { text, name: String(b.name || "").slice(0, 80), title: String(b.title || "").slice(0, 200), slug: /^[a-z0-9]{6,20}$/.test(b.slug || "") ? b.slug : "", at: new Date().toISOString() };
    await env.POSTERS.put("feedback:" + (9999999999999 - Date.now()) + "-" + slugMake(), JSON.stringify(rec));   // newest first when listed
    return json({ ok: true });
  }
  if (p === "/api/feedback" && method === "GET") {
    if (!env.ADMIN_CODE || (request.headers.get("x-admin-code") || "") !== env.ADMIN_CODE) return err(403, "Wrong admin code.", "bad_admin");
    const list = await env.POSTERS.list({ prefix: "feedback:", limit: 200 });
    const items = [];
    for (const k of list.keys) { const v = await env.POSTERS.get(k.name, "json"); if (v) items.push(v); }
    return json({ items });
  }

  /* re-record one panel's narration of a finished poster, with the author's kept clone (or a voice ID given with the admin code) */
  if (p === "/api/rerecord" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const slug = String(b.slug || ""), section = String(b.section || ""), text = String(b.text || "").trim();
    if (!/^[a-z0-9]{6,20}$/.test(slug) || !SECTIONS.includes(section)) return err(400, "Bad request.", "bad_request");
    if (text.length < 20 || text.length > MAX_SCRIPT) return err(400, "The script is empty or too long.", "bad_request");
    const v = await env.POSTERS.get("poster:" + slug, "json");
    if (!v) return err(404, "Poster not found.", "not_found");
    if (!(await canEdit(slug))) return err(403, "Only the browser that made this poster, or the admin code, can edit it.", "not_owner");
    const isAdmin = env.ADMIN_CODE && (request.headers.get("x-admin-code") || "") === env.ADMIN_CODE;
    const voice = v.voiceId || (isAdmin && /^[A-Za-z0-9]{8,64}$/.test(b.voice_id || "") ? b.voice_id : "");
    if (!voice) return err(400, "This poster doesn't have a saved voice. Enter the ElevenLabs voice ID of the author's clone (admin).", "no_voice");
    return slowJson(async () => {
      const audio = await tts(env, voice, text, { seed: seedFor(slug) });
      await env.POSTERS.put(`audio:${slug}:${section}`, audio, { metadata: { bytes: audio.byteLength } });
      v.poster.scripts[section] = text; v.audioVer = { ...(v.audioVer || {}), [section]: Date.now() };
      if (!v.voiceId && isAdmin) v.voiceId = b.voice_id;
      await env.POSTERS.put("poster:" + slug, JSON.stringify(v), { metadata: { title: v.poster.title.slice(0, 200), displayName: v.displayName, createdAt: v.createdAt } });
      return { ok: true, ver: v.audioVer[section] };
    });
  }

  /* voice lab (admin page): compare models and settings on one clone before changing the studio's defaults */
  if (p === "/api/voicelab" && (method === "GET" || method === "POST")) {
    if (!env.ADMIN_CODE || (request.headers.get("x-admin-code") || "") !== env.ADMIN_CODE) return err(403, "Wrong admin code.", "bad_admin");
    if (method === "GET") {
      const res = await fetch(`${elevenBase(env)}/v1/voices`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY, accept: "application/json" } });
      if (!res.ok) return err(502, await upstreamMessage(res, "ElevenLabs (voice list)"), "upstream");
      const voices = ((await res.json()).voices || []).filter(v => v.category === "cloned").map(v => ({ id: v.voice_id, name: v.name }));
      return json({ voices, current: { model: env.MODEL_ID || "eleven_multilingual_v2", stability: Number(env.VOICE_STABILITY ?? 0.7), similarity: Number(env.VOICE_SIMILARITY ?? 0.9) } });
    }
    let b = {}; try { b = await request.json(); } catch {}
    const text = String(b.text || "").trim().slice(0, 1200);
    if (!/^[A-Za-z0-9]{8,64}$/.test(b.voice_id || "") || !text || !/^eleven_[a-z0-9_]{2,40}$/.test(b.model || "")) return err(400, "Bad request.", "bad_request");
    try {
      const seed = Number.isInteger(b.seed) && b.seed >= 0 && b.seed < 4294967295 ? b.seed : undefined;
      const audio = await tts(env, b.voice_id, text, { model: b.model, stability: Math.min(1, Math.max(0, Number(b.stability))), similarity: Math.min(1, Math.max(0, Number(b.similarity))), seed });
      return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    } catch (e) { return err(502, e.message || "ElevenLabs failed.", "upstream"); }
  }

  /* a figure the author cropped from the paper, stored with the poster */
  if (p === "/api/figure" && method === "POST") {
    const voice_id = url.searchParams.get("voice_id") || "", slug = url.searchParams.get("slug") || "", panel = url.searchParams.get("panel") || "";
    const viaVoice = /^[A-Za-z0-9]{8,64}$/.test(voice_id) && url.searchParams.get("voice_token") === await hmac(env, "voice:" + voice_id);
    if (!viaVoice && !(await env.POSTERS.get("poster:" + slug) && await canEdit(slug))) return err(403, "You can't add figures to this poster.", "not_owner");
    if (!/^[a-z0-9]{6,20}$/.test(slug) || !FIGURE_PANELS.includes(panel)) return err(400, "Bad request.", "bad_request");
    const type = (request.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(png|jpeg|webp)$/.test(type)) return err(400, "Figures must be PNG, JPEG or WebP.", "bad_figure");
    const img = await request.arrayBuffer();
    if (!img.byteLength || img.byteLength > MAX_FIGURE) return err(413, "The figure is larger than 4 MB.", "too_large");
    await env.POSTERS.put(`figure:${slug}:${panel}`, img, { metadata: { type } });
    return json({ ok: true });
  }

  if (p === "/api/voice" && method === "POST") {
    if (request.headers.get("x-consent") !== "yes") return err(400, "Consent is required.", "no_consent");
    const name = String(request.headers.get("x-name") || "").trim().slice(0, 80);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return err(400, "No voice sample received.", "bad_request");
    if (bytes.byteLength > MAX_VOICE) return err(413, "The voice sample is larger than 10 MB. Trim it and try again.", "too_large");
    return slowJson(async () => {
      const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const voice_id = await cloneVoice(env, bytes, (name || "Fisher presenter") + " (Fisher poster)", type);
      /* warm-up: the first generation from a brand-new clone is occasionally off (e.g. a different voice), so spend it on a throwaway line */
      await new Promise(r => setTimeout(r, 1500));
      try { await tts(env, voice_id, "Hello, and thanks for stopping by."); } catch {}
      return { voice_id, voice_token: await hmac(env, "voice:" + voice_id), slug: slugMake() };
    });
  }

  if (p === "/api/voice/discard" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    if (!/^[A-Za-z0-9]{8,64}$/.test(b.voice_id || "") || b.voice_token !== await hmac(env, "voice:" + b.voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    if (keepClones(env)) return json({ ok: true, kept: true });
    return json({ ok: await deleteVoice(env, b.voice_id) });
  }

  if (p === "/api/narrate" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const { voice_id, voice_token, slug, section } = b; const text = String(b.text || "").trim();
    if (!/^[A-Za-z0-9]{8,64}$/.test(voice_id || "") || voice_token !== await hmac(env, "voice:" + voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    if (!/^[a-z0-9]{6,20}$/.test(slug || "") || !SECTIONS.includes(section)) return err(400, "Bad request.", "bad_request");
    if (!text || text.length > MAX_SCRIPT) return err(400, "The script is empty or too long.", "bad_request");
    return slowJson(async () => {
      const meta = {};
      const audio = await tts(env, voice_id, text, { seed: seedFor(slug), prev_ids: b.prev_ids, meta });
      await env.POSTERS.put(`audio:${slug}:${section}`, audio, { metadata: { bytes: audio.byteLength } });
      return { ok: true, bytes: audio.byteLength, request_id: meta.requestId };
    });
  }

  if (p === "/api/podcast-line" && method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const { voice_id, voice_token, slug } = b; const text = String(b.text || "").trim(), i = Number(b.index);
    if (!/^[A-Za-z0-9]{8,64}$/.test(voice_id || "") || voice_token !== await hmac(env, "voice:" + voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    if (!/^[a-z0-9]{6,20}$/.test(slug || "") || !Number.isInteger(i) || i < 0 || i >= MAX_POD_LINES) return err(400, "Bad request.", "bad_request");
    if (!text || text.length > MAX_POD_LINE) return err(400, "The line is empty or too long.", "bad_request");
    const meta = {}, ctx = { previous_text: String(b.previous_text || ""), next_text: String(b.next_text || ""), seed: seedFor(slug), prev_ids: b.prev_ids, meta };
    return slowJson(async () => {
      let audio;
      if (b.speaker === "host") {
        const hk = HOSTS[b.host] ? b.host : "stock", fixed = HOSTS[hk].voiceVar && env[HOSTS[hk].voiceVar];
        if (fixed) audio = await tts(env, fixed, text, { ...ctx, model: env[`HOST_${hk.toUpperCase()}_MODEL_ID`] || "" });   // faculty host: their own consented clone, never replaced
        else try { audio = await tts(env, await hostVoice(env), text, ctx); }
        catch (e) {
          if (!/error 404|voice_not_found|not found/i.test(String(e.message))) throw e;
          await env.POSTERS.delete("host_voice");
          audio = await tts(env, await hostVoice(env, true), text, ctx);   // the saved/default voice is gone: pick again
        }
      } else audio = await tts(env, voice_id, text, ctx);
      await env.POSTERS.put(`audio:${slug}:pod-${i}`, audio, { metadata: { bytes: audio.byteLength } });
      return { ok: true, bytes: audio.byteLength, request_id: meta.requestId };
    });
  }

  /* the author's character, made during the build; the photo itself is never stored */
  if (p === "/api/avatar" && method === "POST") {
    const voice_id = url.searchParams.get("voice_id") || "", slug = url.searchParams.get("slug") || "";
    if (!/^[A-Za-z0-9]{8,64}$/.test(voice_id) || url.searchParams.get("voice_token") !== await hmac(env, "voice:" + voice_id)) return err(403, "This voice can't be used here.", "bad_voice");
    if (!/^[a-z0-9]{6,20}$/.test(slug)) return err(400, "Bad request.", "bad_request");
    const ph = await readPhoto(request); if (ph.error) return ph.error;
    return slowJson(async () => {
      const look = await describeLook(env, ph.bytes, ph.type);
      await env.POSTERS.put(`avatar:${slug}`, JSON.stringify(look));
      return { ok: true, look };
    });
  }

  /* host characters (AC, Hun Whee Lee), set once from /admin.html with the ADMIN_CODE secret */
  if (p === "/api/host-avatar" && method === "POST") {
    if (!env.ADMIN_CODE) return err(403, "Add an ADMIN_CODE secret in Cloudflare first.", "no_admin");
    if ((request.headers.get("x-admin-code") || "") !== env.ADMIN_CODE) return err(403, "Wrong admin code.", "bad_admin");
    const host = url.searchParams.get("host") || "";
    if (!["ac", "hun"].includes(host)) return err(400, "Unknown host.", "bad_request");
    const ph = await readPhoto(request); if (ph.error) return ph.error;
    return slowJson(async () => {
      const look = await describeLook(env, ph.bytes, ph.type);
      await env.POSTERS.put(`host_avatar:${host}`, JSON.stringify(look));
      return { ok: true, look };
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
    const podN = poster.podcast.lines.length;
    for (let i = 0; i < podN; i++) if (!(await env.POSTERS.get(`audio:${slug}:pod-${i}`, "arrayBuffer"))) return err(400, "Podcast audio is missing. Build again.", "missing_audio");
    for (const k of Object.keys(poster.figures)) if (!(await env.POSTERS.get(`figure:${slug}:${k}`, "stream"))) delete poster.figures[k];
    const createdAt = Date.now();
    const avatar = !!(await env.POSTERS.get(`avatar:${slug}`));
    await env.POSTERS.put("poster:" + slug, JSON.stringify({ displayName, spokenName, createdAt, poster, audio: SECTIONS, podcast: podN, avatar, ...(keepClones(env) ? { voiceId: String(b.voice_id || "") } : {}) }), { metadata: { title: poster.title.slice(0, 200), displayName, createdAt } });
    /* Every build gets its own permanent link; earlier posters are kept. */
    const ck = ownerKey(ownerId), list = ownedSlugs(await env.POSTERS.get(ck));
    await env.POSTERS.put(ck, JSON.stringify([slug, ...list.filter(x => x !== slug)].slice(0, 200)));
    const voiceDeleted = keepClones(env) ? false : await deleteVoice(env, b.voice_id);
    return json({ ok: true, slug, url: new URL("/p/" + slug, url).toString(), voiceDeleted });
  }

  return err(404, "Not found.", "not_found");
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    const url = new URL(request.url), p = url.pathname;
    try {
      if (p.startsWith("/mcp/") || p === "/health") return mcp.fetch(request, env, ctx);
      if (p.startsWith("/api/")) return await api(request, env, url);
      const fg = p.match(/^\/figure\/([a-z0-9]{6,20})\/(narrative|findings|methods)\.png$/);
      if (fg) {
        const r = await env.POSTERS.getWithMetadata(`figure:${fg[1]}:${fg[2]}`, "arrayBuffer");
        if (!r.value) return new Response("Not found", { status: 404 });
        return new Response(r.value, { headers: { "content-type": (r.metadata && r.metadata.type) || "image/png", "cache-control": "public, max-age=86400" } });
      }
      const av = p.match(/^\/avatar\/(host-(ac|hun)|[a-z0-9]{6,20})\.json$/);
      if (av) {
        let look = await env.POSTERS.get(av[2] ? `host_avatar:${av[2]}` : `avatar:${av[1]}`, "json");
        if (!look && av[2]) look = BUILTIN_HOST_LOOKS[av[2]] || null;
        if (!look) return new Response("Not found", { status: 404 });
        return new Response(JSON.stringify(cleanLook(look)), { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
      }
      let m = p.match(new RegExp("^/audio/([a-z0-9]{6,20})/(" + SECTIONS.join("|") + "|pod-\\d{1,2})\\.mp3$"));
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
