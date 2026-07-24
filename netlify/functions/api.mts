import { getStore } from "@netlify/blobs";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config, Context } from "@netlify/functions";

type Role = "admin" | "user";
type User = { id: string; username: string; salt: string; hash: string; role: Role };
type UsersFile = { users: User[] };
type ImageMeta = { id: string; name: string; mime: string; size: number; createdAt: string; uploadedBy: string };
type ChatMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string; mode: "trip" | "research" | "plan" };
type AssistantState = {
  tripId: string;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  workingMemory: { currentTopic?: string; summary?: string };
  messages: ChatMessage[];
  tripSnapshot?: unknown;
};
type ResearchJob = {
  id: string;
  userId: string;
  status: "queued" | "running" | "complete" | "failed";
  question: string;
  tripData: unknown;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  answer?: string;
  error?: string;
};

const usersStore = () => getStore("road-trip-users", { consistency: "strong" });
const dataStore = () => getStore("road-trip-data", { consistency: "strong" });
const historyStore = () => getStore("road-trip-history", { consistency: "strong" });
const imagesStore = () => getStore("road-trip-images", { consistency: "strong" });
const geoStore = () => getStore("road-trip-geocoding", { consistency: "strong" });
const researchStore = () => getStore("road-trip-research", { consistency: "strong" });
const assistantStore = () => getStore("road-trip-assistant", { consistency: "strong" });
const USERS_KEY = "users";
const DATA_KEY = "itinerary";
const IMAGE_INDEX_KEY = "image-index";
const COOKIE = "road_trip_session";
const TRIP_ID = "netherlands-germany-2026";
const ASSISTANT_KEY = `assistant-${TRIP_ID}`;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
async function secret() {
  const store = usersStore();
  let value = await store.get("session-secret");
  if (!value) { value = randomBytes(48).toString("base64url"); await store.set("session-secret", value); }
  return String(value);
}
function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
function verifyPassword(password: string, user: User) {
  const actual = Buffer.from(hashPassword(password, user.salt).hash, "hex");
  const expected = Buffer.from(user.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function sign(value: string) { return createHmac("sha256", await secret()).update(value).digest("base64url"); }
async function createSession(user: User) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, exp: Date.now() + 7 * 86400000 })).toString("base64url");
  return `${payload}.${await sign(payload)}`;
}
function parseCookies(req: Request) {
  return Object.fromEntries((req.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map(v => {
    const i = v.indexOf("="); return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
async function loadUsers(): Promise<UsersFile> { return (await usersStore().get(USERS_KEY, { type: "json" })) || { users: [] }; }
async function saveUsers(value: UsersFile) { await usersStore().setJSON(USERS_KEY, value); }
async function authenticatedUser(req: Request): Promise<User | null> {
  const token = parseCookies(req)[COOKIE]; if (!token) return null;
  const [payload, signature] = token.split("."); if (!payload || !signature) return null;
  const expected = await sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.id || session.exp < Date.now()) return null;
    return (await loadUsers()).users.find(u => u.id === session.id) || null;
  } catch { return null; }
}
function sessionCookie(value: string, maxAge = 604800) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
async function body(req: Request) { try { return await req.json(); } catch { return {}; } }
function publicUser(u: User) { return { id: u.id, username: u.username, role: u.role }; }
function requireAdmin(user: User) { return user.role === "admin" ? null : json({ error: "This account has read-only access. Administrator access is required to make changes." }, 403); }
function safeImageName(value: string) { return value.replace(/[^a-zA-Z0-9._ -]/g, "").trim().slice(0, 120) || "trip-image"; }
function plainText(value: unknown, max = 500) { return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function compactEntry(item: any, kind: string) {
  if (!item || typeof item !== "object") return null;
  if (kind === "attraction") return { name: plainText(item.name, 100), date: plainText(item.date, 40), notes: plainText(item.notes, 100) };
  if (kind === "accommodation") return { name: plainText(item.name, 100), address: plainText(item.address, 120), checkIn: plainText(item.checkIn, 40), nights: Number(item.nights) || undefined };
  return { operator: plainText(item.operator, 80), route: plainText(item.route, 100), departure: plainText(item.departure, 40), arrival: plainText(item.arrival, 40) };
}
function compactTripData(value: any, question: string, maxDays = 8) {
  const trip = value?.trip && typeof value.trip === "object" ? {
    title: plainText(value.trip.title, 100), dates: plainText(value.trip.dates, 60), vehicle: plainText(value.trip.vehicle, 60),
  } : {};
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const allDays = Array.isArray(value?.days) ? value.days : [];
  const compactDays = allDays.slice(0, 40).map((day: any) => {
    const details = day?.currentDay && typeof day.currentDay === "object" ? day.currentDay : day || {};
    const bookings = day?.bookings && typeof day.bookings === "object" ? day.bookings : {};
    return {
      day: Number(day?.day) || undefined,
      date: plainText(day?.date, 60), title: plainText(details.title, 120), destination: plainText(details.destination, 100),
      driving: plainText(details.drivingDistance, 80), chargeRequired: Boolean(details.destinationCharge), sleeping: plainText(details.sleeping, 80),
      summary: plainText(details.summary, 180),
      attractions: Array.isArray(bookings.attractions) ? bookings.attractions.slice(0, 5).map((x: any) => compactEntry(x, "attraction")).filter(Boolean) : [],
      accommodations: Array.isArray(bookings.accommodations) ? bookings.accommodations.slice(0, 3).map((x: any) => compactEntry(x, "accommodation")).filter(Boolean) : [],
      transport: Array.isArray(bookings.ferries) ? bookings.ferries.slice(0, 3).map((x: any) => compactEntry(x, "transport")).filter(Boolean) : [],
    };
  });
  const relevant = compactDays.filter((day: any) => words.some(word => JSON.stringify(day).toLowerCase().includes(word)));
  return { trip, days: relevant.length ? relevant.slice(0, maxDays) : compactDays.slice(0, maxDays) };
}

async function loadAssistantState(): Promise<AssistantState> {
  return (await assistantStore().get(ASSISTANT_KEY, { type: "json" })) || {
    tripId: TRIP_ID, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workingMemory: {}, messages: []
  };
}
async function saveAssistantState(state: AssistantState) {
  state.updatedAt = new Date().toISOString();
  state.messages = state.messages.slice(-120);
  await assistantStore().setJSON(ASSISTANT_KEY, state);
}
async function openAICreateConversation(apiKey: string) {
  const response = await fetch("https://api.openai.com/v1/conversations", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ metadata: { trip_id: TRIP_ID, app: "holiday-planner" } }),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id) throw new Error(payload?.error?.message || "Could not create the trip conversation.");
  return String(payload.id);
}
async function getOrCreateConversation(apiKey: string, state: AssistantState) {
  if (state.conversationId) return state.conversationId;
  state.conversationId = await openAICreateConversation(apiKey);
  await saveAssistantState(state);
  return state.conversationId;
}
function assistantTools() {
  return [
    { type: "function", name: "get_trip_summary", description: "Return a compact summary of the current trip.", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { type: "function", name: "search_trip", description: "Search trip days, attractions, accommodation and transport for a place or phrase.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
    { type: "function", name: "get_trip_day", description: "Return one trip day by its day number.", parameters: { type: "object", properties: { dayNumber: { type: "integer", minimum: 1 } }, required: ["dayNumber"], additionalProperties: false } },
  ];
}
function runAssistantTool(name: string, args: any, snapshot: any) {
  const compact = compactTripData(snapshot || {}, String(args?.query || ""), 40) as any;
  if (name === "get_trip_summary") return { trip: compact.trip, days: compact.days.map((d: any) => ({ day: d.day, date: d.date, title: d.title, destination: d.destination, sleeping: d.sleeping })) };
  if (name === "get_trip_day") return compact.days.find((d: any) => d.day === Number(args?.dayNumber)) || { error: "Day not found" };
  if (name === "search_trip") {
    const q = plainText(args?.query, 120).toLowerCase();
    if (!q) return [];
    return compact.days.filter((d: any) => JSON.stringify(d).toLowerCase().includes(q)).slice(0, 6);
  }
  return { error: "Unknown tool" };
}
function functionCalls(payload: any) {
  return (Array.isArray(payload?.output) ? payload.output : []).filter((item: any) => item?.type === "function_call");
}
async function respondWithTools(apiKey: string, conversationId: string, question: string, snapshot: any, instructions: string, web = false) {
  const request: any = {
    model: Netlify.env.get(web ? "OPENAI_RESEARCH_MODEL" : "OPENAI_MODEL") || Netlify.env.get("OPENAI_MODEL") || "gpt-5-mini",
    conversation: conversationId,
    instructions,
    ...(web ? {} : { reasoning: { effort: "minimal" } }),
    max_output_tokens: web ? 1400 : 800,
    tools: [...assistantTools(), ...(web ? [{ type: "web_search" }] : [])],
    input: [{ role: "user", content: question }],
  };
  let result = await openAIRequest(apiKey, request, web ? 45000 : 15000);
  if (!result.response.ok) return result;
  const calls = functionCalls(result.payload);
  if (!calls.length) return result;
  const outputs = calls.slice(0, 4).map((call: any) => {
    let args = {}; try { args = JSON.parse(call.arguments || "{}"); } catch {}
    return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(runAssistantTool(call.name, args, snapshot)) };
  });
  return openAIRequest(apiKey, {
    model: request.model, conversation: conversationId, instructions,
    ...(web ? {} : { reasoning: { effort: "minimal" } }),
    max_output_tokens: request.max_output_tokens, tools: request.tools, input: outputs,
  }, web ? 45000 : 15000);
}

function extractResponseText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || []).flatMap((item: any) => item?.content || [])
    .filter((content: any) => content?.type === "output_text" && typeof content.text === "string")
    .map((content: any) => content.text).join("\n").trim();
}
async function openAIRequest(apiKey: string, requestBody: Record<string, unknown>, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const payload: any = await response.json().catch(() => ({}));
    return { response, payload };
  } finally { clearTimeout(timeout); }
}
function openAIError(payload: any, fallback = "The AI request failed.") {
  const code = payload?.error?.code;
  if (code === "rate_limit_exceeded") return { status: 429, message: "The OpenAI rate limit was exceeded. Please wait briefly and try again." };
  if (code === "insufficient_quota") return { status: 402, message: "The OpenAI API account has no available credit or has reached its spending limit." };
  return { status: 502, message: payload?.error?.message || fallback };
}

export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const method = req.method.toUpperCase();
    const usersFile = await loadUsers();
    const user = await authenticatedUser(req);

    if (path === "status" && method === "GET") return json({ initialized: usersFile.users.length > 0, user: user ? publicUser(user) : null });
    if (path === "setup" && method === "POST") {
      if (usersFile.users.length) return json({ error: "Setup has already been completed." }, 409);
      const input: any = await body(req); const username = String(input.username || "").trim(); const password = String(input.password || "");
      if (username.length < 2 || password.length < 8) return json({ error: "Use a username of at least 2 characters and a password of at least 8 characters." }, 400);
      const pw = hashPassword(password); const created: User = { id: crypto.randomUUID(), username, ...pw, role: "admin" };
      await saveUsers({ users: [created] });
      return json({ user: publicUser(created) }, 201, { "set-cookie": sessionCookie(await createSession(created)) });
    }
    if (path === "login" && method === "POST") {
      const input: any = await body(req); const username = String(input.username || "").trim(); const password = String(input.password || "");
      const found = usersFile.users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!found || !verifyPassword(password, found)) return json({ error: "Incorrect username or password." }, 401);
      return json({ user: publicUser(found) }, 200, { "set-cookie": sessionCookie(await createSession(found)) });
    }
    if (path === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
    if (!user) return json({ error: "Authentication required." }, 401);

    if (path === "currency-rate" && method === "GET") {
      const cacheKey = "currency-EUR-GBP";
      const cached: any = await geoStore().get(cacheKey, { type: "json" });
      if (cached?.rate && cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < 6 * 60 * 60 * 1000) return json(cached);
      try {
        const response = await fetch("https://api.frankfurter.dev/v2/rate/EUR/GBP", { headers: { accept: "application/json" } });
        const payload: any = await response.json().catch(() => ({}));
        if (!response.ok || !Number.isFinite(Number(payload.rate))) throw new Error("Invalid exchange-rate response");
        const result = { base: "EUR", quote: "GBP", rate: Number(payload.rate), date: String(payload.date || ""), fetchedAt: new Date().toISOString(), source: "Frankfurter" };
        await geoStore().setJSON(cacheKey, result);
        return json(result);
      } catch {
        if (cached?.rate) return json({ ...cached, stale: true });
        return json({ error: "The EUR to GBP exchange rate is temporarily unavailable." }, 503);
      }
    }
    if (path === "data" && method === "GET") return json({ data: (await dataStore().get(DATA_KEY, { type: "json" })) || {}, storage: "netlify-blobs" });
    if (path === "data" && method === "PUT") {
      const denied = requireAdmin(user); if (denied) return denied;
      const input: any = await body(req);
      if (!input || typeof input.data !== "object" || Array.isArray(input.data)) return json({ error: "Invalid trip data." }, 400);
      const previous = await dataStore().get(DATA_KEY, { type: "json" });
      if (previous) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await historyStore().setJSON(`snapshot-${stamp}-${crypto.randomUUID()}`, { savedAt: new Date().toISOString(), savedBy: user.username, data: previous });
      }
      await dataStore().setJSON(DATA_KEY, input.data);
      return json({ ok: true, storage: "netlify-blobs" });
    }
    if (path === "history/undo" && method === "POST") {
      const denied = requireAdmin(user); if (denied) return denied;
      const listed = await historyStore().list({ prefix: "snapshot-" });
      const latest = [...listed.blobs].sort((a, b) => b.key.localeCompare(a.key))[0];
      if (!latest) return json({ error: "There is no earlier saved version to restore." }, 404);
      const snapshot: any = await historyStore().get(latest.key, { type: "json" });
      if (!snapshot?.data) return json({ error: "The latest history snapshot is invalid." }, 500);
      const current = await dataStore().get(DATA_KEY, { type: "json" });
      if (current) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await historyStore().setJSON(`redo-${stamp}-${crypto.randomUUID()}`, { savedAt: new Date().toISOString(), savedBy: user.username, data: current });
      }
      await dataStore().setJSON(DATA_KEY, snapshot.data);
      await historyStore().delete(latest.key);
      return json({ ok: true, data: snapshot.data, restoredFrom: snapshot.savedAt || latest.key });
    }

    if (path === "images" && method === "GET") {
      const images = (await imagesStore().get(IMAGE_INDEX_KEY, { type: "json" })) || [];
      return json({ images: (images as ImageMeta[]).map(image => ({ ...image, url: `/api/images/${image.id}` })) });
    }
    if (path === "images" && method === "POST") {
      const denied = requireAdmin(user); if (denied) return denied;
      const input: any = await body(req); const name = safeImageName(String(input.name || "trip-image")); const mime = String(input.mime || "");
      const encoded = String(input.data || "").replace(/^data:[^;]+;base64,/, "");
      if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return json({ error: "Use a JPG, PNG, WebP or GIF image." }, 400);
      let bytes: Buffer; try { bytes = Buffer.from(encoded, "base64"); } catch { return json({ error: "The image could not be decoded." }, 400); }
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return json({ error: "Images must be between 1 byte and 4 MB." }, 400);
      const id = crypto.randomUUID();
      await imagesStore().set(`asset-${id}`, bytes, { metadata: { contentType: mime } });
      const item: ImageMeta = { id, name, mime, size: bytes.length, createdAt: new Date().toISOString(), uploadedBy: user.username };
      const images = ((await imagesStore().get(IMAGE_INDEX_KEY, { type: "json" })) || []) as ImageMeta[];
      images.unshift(item); await imagesStore().setJSON(IMAGE_INDEX_KEY, images.slice(0, 250));
      return json({ image: { ...item, url: `/api/images/${id}` } }, 201);
    }
    const imageMatch = path.match(/^images\/([a-f0-9-]+)$/i);
    if (imageMatch && method === "GET") {
      const result = await imagesStore().getWithMetadata(`asset-${imageMatch[1]}`, { type: "arrayBuffer" });
      if (!result) return json({ error: "Image not found." }, 404);
      return new Response(result.data, { headers: { "content-type": String((result.metadata as any)?.contentType || "application/octet-stream"), "cache-control": "public, max-age=31536000, immutable" } });
    }

    if (path === "geocode" && method === "POST") {
      const input: any = await body(req); const query = String(input.query || "").trim();
      if (query.length < 2 || query.length > 180) return json({ error: "Enter a destination to locate." }, 400);
      const key = `q-${createHmac("sha256", "road-trip-geocode").update(query.toLowerCase()).digest("hex")}`;
      const cached = await geoStore().get(key, { type: "json" }); if (cached) return json(cached);
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, { headers: { "user-agent": "PersonalRoadTripPlanner/1.0", "accept-language": "en-GB,en" } });
      if (!response.ok) return json({ error: "The mapping service is unavailable." }, 502);
      const matches: any[] = await response.json(); if (!matches.length) return json({ error: "No matching place was found. Try adding the country." }, 404);
      const result = { destination: matches[0].display_name, lat: Number(matches[0].lat), lng: Number(matches[0].lon) };
      await geoStore().setJSON(key, result); return json(result);
    }

    if (path === "assistant/state" && method === "GET") {
      const state = await loadAssistantState();
      return json({ tripId: state.tripId, conversationReady: Boolean(state.conversationId), workingMemory: state.workingMemory, messages: state.messages });
    }
    if (path === "assistant/new-chat" && method === "POST") {
      const apiKey = Netlify.env.get("OPENAI_API_KEY"); if (!apiKey) return json({ error: "AI is not configured." }, 503);
      const previous = await loadAssistantState();
      const now = new Date().toISOString();
      const fresh: AssistantState = { tripId: TRIP_ID, conversationId: await openAICreateConversation(apiKey), createdAt: now, updatedAt: now, workingMemory: {}, messages: [], tripSnapshot: previous.tripSnapshot };
      await saveAssistantState(fresh);
      return json({ ok: true, conversationReady: true, messages: [] });
    }
    if (path === "assistant/ask" && method === "POST") {
      const apiKey = Netlify.env.get("OPENAI_API_KEY"); if (!apiKey) return json({ error: "AI is not configured." }, 503);
      const input: any = await body(req); const question = String(input.question || "").trim(); const mode = input.mode === "plan" ? "plan" : "trip";
      if (!question || question.length > 1600) return json({ error: "Ask a question of up to 1,600 characters." }, 400);
      const state = await loadAssistantState();
      if (input.tripData && typeof input.tripData === "object") state.tripSnapshot = input.tripData;
      const conversationId = await getOrCreateConversation(apiKey, state);
      const instructions = mode === "plan"
        ? "You are a practical family travel planner. Continue the existing trip conversation naturally. Use the trip tools whenever current itinerary facts are needed. Propose changes but never claim they have been applied. Keep the answer under 500 words."
        : "You are a concise assistant for this private family road trip. Continue the existing conversation naturally. Use the trip tools whenever itinerary facts are needed. Do not invent trip facts. For current public information, tell the user to use Research. Keep the answer under 400 words.";
      try {
        const { response, payload } = await respondWithTools(apiKey, conversationId, question, state.tripSnapshot, instructions, false);
        if (!response.ok) { const err = openAIError(payload); return json({ error: err.message }, err.status); }
        const answer = extractResponseText(payload);
        if (!answer) return json({ error: "The AI returned no text. Please try again." }, 502);
        const now = new Date().toISOString();
        state.messages.push({ id: crypto.randomUUID(), role: "user", text: question, createdAt: now, mode });
        state.messages.push({ id: crypto.randomUUID(), role: "assistant", text: answer, createdAt: new Date().toISOString(), mode });
        await saveAssistantState(state);
        return json({ answer, mode, conversationReady: true, messages: state.messages });
      } catch (error: any) {
        if (error?.name === "AbortError") return json({ error: "The assistant did not respond in time. Try a shorter question." }, 504);
        throw error;
      }
    }

    if (path === "assistant/research" && method === "POST") {
      const apiKey = Netlify.env.get("OPENAI_API_KEY"); if (!apiKey) return json({ error: "AI is not configured." }, 503);
      const input: any = await body(req); const question = String(input.question || "").trim();
      if (!question || question.length > 1600) return json({ error: "Enter a research question of up to 1,600 characters." }, 400);
      const state = await loadAssistantState();
      if (input.tripData && typeof input.tripData === "object") state.tripSnapshot = input.tripData;
      const conversationId = await getOrCreateConversation(apiKey, state);
      await saveAssistantState(state);
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      const job: ResearchJob = { id, userId: user.id, status: "queued", question, tripData: compactTripData(state.tripSnapshot || {}, question, 6), conversationId, createdAt: now, updatedAt: now };
      await researchStore().setJSON(`job-${id}`, job);
      const token = await sign(`research:${id}`);
      const workerUrl = new URL("/.netlify/functions/research-background", req.url);
      const invoke = await fetch(workerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, token }) });
      if (!invoke.ok && invoke.status !== 202) {
        job.status = "failed"; job.error = "The research worker could not be started."; job.updatedAt = new Date().toISOString();
        await researchStore().setJSON(`job-${id}`, job); return json({ error: job.error }, 502);
      }
      state.messages.push({ id: crypto.randomUUID(), role: "user", text: question, createdAt: now, mode: "research" });
      await saveAssistantState(state);
      return json({ id, status: "queued" }, 202);
    }
    const researchMatch = path.match(/^assistant\/research\/([a-f0-9-]+)$/i);
    if (researchMatch && method === "GET") {
      const job = await researchStore().get(`job-${researchMatch[1]}`, { type: "json" }) as ResearchJob | null;
      if (!job || (job.userId !== user.id && user.role !== "admin")) return json({ error: "Research job not found." }, 404);
      if (job.status === "complete" && job.answer) {
        const state = await loadAssistantState();
        if (!state.messages.some(m => m.role === "assistant" && m.mode === "research" && m.text === job.answer)) {
          state.messages.push({ id: crypto.randomUUID(), role: "assistant", text: job.answer, createdAt: job.updatedAt, mode: "research" }); await saveAssistantState(state);
        }
      }
      return json({ id: job.id, status: job.status, answer: job.answer, error: job.error, updatedAt: job.updatedAt });
    }

    if (path === "users" && method === "GET") {
      const denied = requireAdmin(user); if (denied) return denied;
      return json({ users: usersFile.users.map(publicUser) });
    }
    if (path === "users" && method === "POST") {
      const denied = requireAdmin(user); if (denied) return denied;
      const input: any = await body(req); const username = String(input.username || "").trim(); const password = String(input.password || "");
      const role: Role = input.role === "admin" ? "admin" : "user";
      if (username.length < 2 || password.length < 8) return json({ error: "Use a username of at least 2 characters and a password of at least 8 characters." }, 400);
      if (usersFile.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return json({ error: "That username already exists." }, 409);
      const pw = hashPassword(password); const created: User = { id: crypto.randomUUID(), username, ...pw, role };
      usersFile.users.push(created); await saveUsers(usersFile); return json({ user: publicUser(created) }, 201);
    }
    const match = path.match(/^users\/([^/]+)$/);
    if (match && method === "PATCH") {
      const denied = requireAdmin(user); if (denied) return denied;
      const target = usersFile.users.find(u => u.id === match[1]); if (!target) return json({ error: "User not found." }, 404);
      const input: any = await body(req);
      if (typeof input.password === "string" && input.password.length) {
        if (input.password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
        Object.assign(target, hashPassword(input.password));
      }
      if (input.role === "admin" || input.role === "user") {
        if (target.id === user.id && input.role !== "admin") return json({ error: "You cannot remove your own administrator access." }, 400);
        const adminCount = usersFile.users.filter(u => u.role === "admin").length;
        if (target.role === "admin" && input.role === "user" && adminCount <= 1) return json({ error: "At least one administrator account is required." }, 400);
        target.role = input.role;
      }
      await saveUsers(usersFile); return json({ user: publicUser(target) });
    }
    if (match && method === "DELETE") {
      const denied = requireAdmin(user); if (denied) return denied;
      if (match[1] === user.id) return json({ error: "You cannot delete the signed-in account." }, 400);
      const target = usersFile.users.find(u => u.id === match[1]); if (!target) return json({ error: "User not found." }, 404);
      if (target.role === "admin" && usersFile.users.filter(u => u.role === "admin").length <= 1) return json({ error: "At least one administrator account is required." }, 400);
      await saveUsers({ users: usersFile.users.filter(u => u.id !== match[1]) }); return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    console.error(error); return json({ error: "The server could not complete the request." }, 500);
  }
};

export const config: Config = { path: "/api/*" };
