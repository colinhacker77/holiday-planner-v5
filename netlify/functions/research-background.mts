import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "@netlify/functions";

type ResearchJob = {
  id: string; userId: string; status: "queued" | "running" | "complete" | "failed";
  question: string; tripData: unknown; conversationId?: string; createdAt: string; updatedAt: string; answer?: string; error?: string;
};
const usersStore = () => getStore("road-trip-users", { consistency: "strong" });
const researchStore = () => getStore("road-trip-research", { consistency: "strong" });
async function secret() { return String(await usersStore().get("session-secret") || ""); }
async function validToken(id: string, token: string) {
  const expected = createHmac("sha256", await secret()).update(`research:${id}`).digest("base64url");
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
function extractResponseText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((content: any) => typeof content?.text === "string" ? content.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}
function incompleteMessage(payload: any) {
  const reason = payload?.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "The research model used its output allowance before producing a final answer. Please try again.";
  if (payload?.status === "incomplete") return `The research response was incomplete${reason ? ` (${reason})` : ""}. Please try again.`;
  return "No answer was returned by the research model.";
}
export default async (req: Request, context: Context) => {
  const input: any = await req.json().catch(() => ({}));
  const id = String(input.id || ""); const token = String(input.token || "");
  if (!id || !token || !(await validToken(id, token))) { console.error("Invalid research invocation"); return; }
  const store = researchStore();
  const job = await store.get(`job-${id}`, { type: "json" }) as ResearchJob | null;
  if (!job) return;
  job.status = "running"; job.updatedAt = new Date().toISOString(); await store.setJSON(`job-${id}`, job);
  try {
    const apiKey = Netlify.env.get("OPENAI_API_KEY"); if (!apiKey) throw new Error("AI is not configured.");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: Netlify.env.get("OPENAI_RESEARCH_MODEL") || Netlify.env.get("OPENAI_MODEL") || "gpt-5-mini",
        instructions: "You are the research mode of a persistent private family travel assistant. Continue the existing trip conversation naturally. Use the small supplied trip context only when relevant. Search the web for current facts, be concise, state uncertainty, cite source names and URLs, and never claim to change the itinerary.",
        ...(job.conversationId ? { conversation: job.conversationId } : {}),
        tools: [{ type: "web_search" }],
        max_output_tokens: 1400,
        input: `Relevant trip context (may be empty):\n${JSON.stringify(job.tripData)}\n\nResearch question:\n${job.question}`,
      }),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || "The research request failed.");
    const answer = extractResponseText(payload);
    if (!answer) {
      console.error("OpenAI research response contained no text", {
        status: payload?.status,
        incomplete_details: payload?.incomplete_details,
        usage: payload?.usage,
        output_types: Array.isArray(payload?.output) ? payload.output.map((item: any) => item?.type) : [],
      });
      throw new Error(incompleteMessage(payload));
    }
    job.answer = answer; job.status = "complete";
  } catch (error: any) {
    console.error(error); job.status = "failed"; job.error = error?.message || "Research failed.";
  }
  job.updatedAt = new Date().toISOString(); await store.setJSON(`job-${id}`, job);
};
