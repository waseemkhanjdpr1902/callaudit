import { NextResponse } from "next/server";

type Criterion = { name: string; weight: number; description: string };
type JsonRecord = Record<string, unknown>;

export const runtime = "nodejs";
export const maxDuration = 300;

const SYSTEM_PROMPT = `You are a strict but fair customer-service quality auditor. Detect and preserve the spoken language, including mixed English, Hindi and Urdu. Judge only evidence present in the call; write "Not evidenced" rather than inventing details. Protect personal data by replacing account numbers, phone numbers, card details and addresses with [REDACTED].`;

function auditPrompt(criteria: Criterion[], transcript?: string) {
  return `${SYSTEM_PROMPT}\n\nScorecard: ${JSON.stringify(criteria)}${transcript ? `\n\nCall transcript:\n${transcript}` : "\n\nTranscribe and audit the attached call."}\n\nReturn JSON only with this exact structure: {"overallScore": number 0-100, "language": string, "summary": string, "disposition": "Pass"|"Needs coaching"|"Critical", "sections": [{"name": string, "score": number 0-100, "weight": number, "finding": string, "evidence": string}], "criticalFailures": string[], "strengths": string[], "coaching": string[], "transcriptExcerpt": string}. The overall score must reflect the supplied weights. Mark Critical only for a material privacy, fraud, abuse, mis-selling or mandatory-compliance failure.`;
}

function parseJson(text: string): JsonRecord {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI returned invalid JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as JsonRecord;
}

async function auditWithGemini(audio: File, criteria: Criterion[], apiKey: string) {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: auditPrompt(criteria) }, { inlineData: { mimeType: audio.type || "audio/mpeg", data: btoa(binary) } }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 5000 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini failed with ${response.status}`);
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
  const transcriptionResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: transcriptionForm,
  });
  if (!transcriptionResponse.ok) throw new Error(`Groq transcription failed with ${transcriptionResponse.status}`);
  const transcription = await transcriptionResponse.json();
  if (!transcription.text) throw new Error("Groq returned an empty transcript");

  const auditResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: auditPrompt(criteria, transcription.text) },
      ],
    }),
  });
  if (!auditResponse.ok) throw new Error(`Groq audit failed with ${auditResponse.status}`);
  const auditPayload = await auditResponse.json();
  return parseJson(auditPayload.choices?.[0]?.message?.content || "");
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
    if (audio.size > 4 * 1024 * 1024) return NextResponse.json({ error: "Audio files must be 4 MB or smaller." }, { status: 413 });
    if (!audio.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(audio.name)) return NextResponse.json({ error: "Unsupported audio format." }, { status: 415 });

    let criteria: Criterion[] = [];
    try { criteria = JSON.parse(String(form.get("criteria") || "[]")); } catch { return NextResponse.json({ error: "The audit checklist is invalid." }, { status: 400 }); }
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 30) return NextResponse.json({ error: "Add between 1 and 30 audit parameters." }, { status: 400 });
    criteria = criteria.map(item => ({ name: String(item.name || "").slice(0, 120), weight: Number(item.weight), description: String(item.description || "").slice(0, 500) })).filter(item => item.name && Number.isFinite(item.weight) && item.weight >= 0);
    if (Math.round(criteria.reduce((sum, item) => sum + item.weight, 0)) !== 100) return NextResponse.json({ error: "Audit parameter weights must total 100%." }, { status: 400 });

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!geminiKey && !groqKey) return NextResponse.json({ error: "AI auditing is not configured. Add GEMINI_API_KEY or GROQ_API_KEY in Vercel." }, { status: 503 });

    let result: JsonRecord | undefined;
    let provider = "";
    if (geminiKey) {
      try { result = await auditWithGemini(audio, criteria, geminiKey); provider = "gemini"; } catch (error) { console.warn("Gemini audit failed; trying Groq fallback.", error); }
    }
    if (!result && groqKey) {
      try { result = await auditWithGroq(audio, criteria, groqKey); provider = "groq"; } catch (error) { console.error("Groq fallback failed.", error); }
    }
    if (!result) return NextResponse.json({ error: "Both AI providers could not process this recording. Try a shorter file or another supported format." }, { status: 502 });

    return NextResponse.json({ result: { ...result, fileName: audio.name }, provider }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Audit request failed.", error);
    return NextResponse.json({ error: "This recording could not be audited. Please verify the file and try again." }, { status: 500 });
  }
}
