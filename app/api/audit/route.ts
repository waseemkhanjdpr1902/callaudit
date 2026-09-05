import { NextResponse } from "next/server";
import { del } from "@vercel/blob";

type Criterion = { name: string; weight: number; description: string };
type JsonRecord = Record<string, unknown>;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export const runtime = "nodejs";
export const maxDuration = 300;

const SYSTEM_PROMPT = `You are a senior Quality Analyst for an Indian stock-broking customer-support operation. Audit calls semantically, not by exact keyword matching. Detect English, Hindi, Urdu, Hinglish and mixed-language speech, including imperfect ASR spellings. Judge only audible evidence and never invent omissions.

BROKING QA POLICY:
1. Greeting: Count a greeting as completed when the agent professionally welcomes or greets the customer, identifies the company or self, or offers assistance. Examples include "good morning/afternoon/evening", "welcome", "namaskar", "salaam", "main [name] bol raha/rahi hoon", "how may I help", and close semantic variants. A greeting does not need every element to pass. Do not mark "greeting not done" if any greeting evidence exists. If the recording starts mid-conversation or the opening is clipped, state "Opening not assessable" and do not assume failure.
2. Verification: For an account-specific interaction, PAN, registered email, date of birth, client code, trading/account ID, registered mobile number, or another approved identifier counts as verification. One clearly requested or confirmed approved identifier satisfies basic verification unless the supplied scorecard explicitly requires two factors. Do not penalize the agent merely for using PAN, email or DOB for verification. Mask the actual value in evidence as [REDACTED].
3. Verification applicability: Verification is not required before purely general information that reveals no customer/account data. It becomes required before account-specific holdings, ledger, trades, orders, funds, profile data or transaction details are disclosed or changed. A wrong-number or misdirected call does not automatically create a verification failure.
4. Broking accuracy: Assess correct understanding and handling of trading, order status, funds/ledger, brokerage/charges, contract notes, holdings, demat/DP, pledging/margin, KYC, account access, complaints and escalation. Do not claim a process is wrong unless the recording or supplied criteria supports that conclusion.
5. Regulatory conduct: Flag guaranteed-return claims, unauthorized investment advice, mis-selling, concealment of risk/charges, unsafe order handling, privacy breach, abusive conduct or fabricated commitments. Asking an approved verification question is not itself a privacy breach.
6. Resolution and ownership: Credit correct guidance, ticket/reference creation, realistic turnaround time, escalation, callback commitment, or clear next steps. Do not require an immediate resolution when escalation is appropriate.
7. Evidence consistency: Every negative finding must cite a relevant transcript quote or say "Not evidenced". If quoted evidence shows that an action occurred, the finding and score must credit it. Never say "not done" while quoting proof that it was done.
8. Scoring: 90-100 excellent, 75-89 compliant with minor improvement, 60-74 coaching required, below 60 material gaps. Use Critical only for a material regulatory, privacy, fraud, abuse, unauthorized-trading or mis-selling event—not for a routine soft-skill omission.

Protect personal data by replacing PAN values, account/client IDs, phone numbers, email addresses, DOB, card details and addresses with [REDACTED].`;

function auditPrompt(criteria: Criterion[], transcript?: string) {
  return `${SYSTEM_PROMPT}\n\nScorecard: ${JSON.stringify(criteria)}${transcript ? `\n\nCall transcript:\n${transcript}` : "\n\nTranscribe and audit the attached call."}\n\nBefore returning the result, silently build an evidence ledger and cross-check that each finding agrees with its evidence. Return JSON only with this exact structure: {"overallScore": number 0-100, "language": string, "summary": string, "disposition": "Pass"|"Needs coaching"|"Critical", "sections": [{"name": string, "score": number 0-100, "weight": number, "finding": string, "evidence": string}], "criticalFailures": string[], "strengths": string[], "coaching": string[], "transcriptExcerpt": string}. Include every supplied scorecard section exactly once, using its supplied name and weight. Calculate overallScore as the weighted average of section scores. Mark Critical only for a material regulatory, privacy, fraud, abuse, unauthorized-trading, mis-selling or mandatory-compliance failure.`;
}

function parseJson(text: string): JsonRecord {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI returned invalid JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as JsonRecord;
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url: string, init: RequestInit, label: string, attempts = 3) {
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      lastResponse = response;
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === attempts) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * 2 ** (attempt - 1));
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`[${label}] network attempt ${attempt} failed; retrying`, error);
      await wait(750 * 2 ** (attempt - 1));
    }
  }
  return lastResponse!;
}

async function providerError(response: Response, label: string) {
  const details = (await response.text()).slice(0, 500).replace(/\s+/g, " ");
  return `${label} failed with ${response.status}${details ? `: ${details}` : ""}`;
}

async function auditWithGemini(audio: File, criteria: Criterion[], apiKey: string) {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: auditPrompt(criteria) }, { inlineData: { mimeType: audio.type || "audio/mpeg", data: btoa(binary) } }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 5000 },
    }),
  }, "gemini");
  if (!response.ok) throw new Error(await providerError(response, "Gemini"));
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  return parseJson(text);
}

async function auditWithGroq(audio: File, criteria: Criterion[], apiKey: string) {
  const transcriptionForm = new FormData();
  transcriptionForm.append("file", audio, audio.name);
  transcriptionForm.append("model", process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo");
  transcriptionForm.append("response_format", "json");
  transcriptionForm.append("temperature", "0");
  const transcriptionResponse = await fetchWithRetry("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: transcriptionForm,
  }, "groq-transcription");
  if (!transcriptionResponse.ok) throw new Error(await providerError(transcriptionResponse, "Groq transcription"));
  const transcription = await transcriptionResponse.json();
  if (!transcription.text) throw new Error("Groq returned an empty transcript");

  const configuredModel = process.env.GROQ_MODEL;
  const models = [...new Set([configuredModel, "llama-3.3-70b-versatile", "openai/gpt-oss-120b"].filter(Boolean))] as string[];
  let lastError = "No Groq audit model succeeded";
  for (const model of models) {
    const auditResponse = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: auditPrompt(criteria, transcription.text) },
        ],
      }),
    }, `groq-audit-${model}`);
    if (auditResponse.ok) {
      const auditPayload = await auditResponse.json();
      return parseJson(auditPayload.choices?.[0]?.message?.content || "");
    }
    lastError = await providerError(auditResponse, `Groq audit model ${model}`);
    if (![400, 404, 422].includes(auditResponse.status)) break;
  }
  throw new Error(lastError);
}

export async function POST(request: Request) {
  let temporaryBlobUrl = "";
  try {
    let audio: File;
    let criteriaValue: unknown;
    if ((request.headers.get("content-type") || "").includes("application/json")) {
      const body = await request.json() as { audioUrl?: string; fileName?: string; fileType?: string; criteria?: unknown };
      if (!body.audioUrl || !body.audioUrl.startsWith("https://") || !new URL(body.audioUrl).hostname.endsWith(".public.blob.vercel-storage.com")) {
        return NextResponse.json({ error: "A valid temporary audio upload is required." }, { status: 400 });
      }
      temporaryBlobUrl = body.audioUrl;
      const source = await fetch(body.audioUrl, { cache: "no-store" });
      if (!source.ok) throw new Error(`Temporary audio download failed with ${source.status}`);
      const declaredSize = Number(source.headers.get("content-length") || 0);
      if (declaredSize > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio files must be 25 MB or smaller." }, { status: 413 });
      const bytes = await source.arrayBuffer();
      if (bytes.byteLength > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio files must be 25 MB or smaller." }, { status: 413 });
      audio = new File([bytes], String(body.fileName || "recording.mp3"), { type: String(body.fileType || source.headers.get("content-type") || "audio/mpeg") });
      criteriaValue = body.criteria;
    } else {
      const form = await request.formData();
      const file = form.get("audio");
      if (!(file instanceof File)) return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
      audio = file;
      criteriaValue = form.get("criteria");
    }
    if (audio.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio files must be 25 MB or smaller." }, { status: 413 });
    if (!audio.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(audio.name)) return NextResponse.json({ error: "Unsupported audio format." }, { status: 415 });

    let criteria: Criterion[] = [];
    try { criteria = typeof criteriaValue === "string" ? JSON.parse(criteriaValue) : criteriaValue as Criterion[]; } catch { return NextResponse.json({ error: "The audit checklist is invalid." }, { status: 400 }); }
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 30) return NextResponse.json({ error: "Add between 1 and 30 audit parameters." }, { status: 400 });
    criteria = criteria.map(item => ({ name: String(item.name || "").slice(0, 120), weight: Number(item.weight), description: String(item.description || "").slice(0, 500) })).filter(item => item.name && Number.isFinite(item.weight) && item.weight >= 0);
    if (Math.round(criteria.reduce((sum, item) => sum + item.weight, 0)) !== 100) return NextResponse.json({ error: "Audit parameter weights must total 100%." }, { status: 400 });

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!geminiKey && !groqKey) return NextResponse.json({ error: "AI auditing is not configured. Add GEMINI_API_KEY or GROQ_API_KEY in Vercel." }, { status: 503 });

    let result: JsonRecord | undefined;
    let provider = "";
    const providerErrors: string[] = [];
    if (geminiKey) {
      try { result = await auditWithGemini(audio, criteria, geminiKey); provider = "gemini"; } catch (error) { const message = error instanceof Error ? error.message : "Gemini failed"; providerErrors.push(message); console.warn("Gemini audit failed; trying Groq fallback.", error); }
    }
    if (!result && groqKey) {
      try { result = await auditWithGroq(audio, criteria, groqKey); provider = "groq"; } catch (error) { const message = error instanceof Error ? error.message : "Groq failed"; providerErrors.push(message); console.error("Groq fallback failed.", error); }
    }
    if (!result) return NextResponse.json({ error: "AI providers could not process this recording.", details: providerErrors.join(" · ") || "No configured provider was available." }, { status: 502 });

    return NextResponse.json({ result: { ...result, fileName: audio.name }, provider }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Audit request failed.", error);
    return NextResponse.json({ error: "This recording could not be audited. Please verify the file and try again." }, { status: 500 });
  } finally {
    if (temporaryBlobUrl) {
      try { await del(temporaryBlobUrl); } catch (error) { console.warn("[audit] temporary blob cleanup failed", error); }
    }
  }
}
