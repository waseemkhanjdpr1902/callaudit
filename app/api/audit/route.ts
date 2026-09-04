import { NextResponse } from "next/server";

type Criterion = { name: string; weight: number; description: string };
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const form = await request.formData(); const audio = form.get("audio");
    if (!(audio instanceof File)) return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
    if (audio.size > 4 * 1024 * 1024) return NextResponse.json({ error: "Audio files must be 4 MB or smaller." }, { status: 413 });
    if (!audio.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(audio.name)) return NextResponse.json({ error: "Unsupported audio format." }, { status: 415 });
    let criteria: Criterion[] = []; try { criteria = JSON.parse(String(form.get("criteria") || "[]")); } catch { return NextResponse.json({ error: "The audit checklist is invalid." }, { status: 400 }); }
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 30) return NextResponse.json({ error: "Add between 1 and 30 audit parameters." }, { status: 400 });
    criteria = criteria.map(item => ({ name: String(item.name || "").slice(0, 120), weight: Number(item.weight), description: String(item.description || "").slice(0, 500) })).filter(item => item.name && Number.isFinite(item.weight));
    if (Math.round(criteria.reduce((sum, item) => sum + item.weight, 0)) !== 100) return NextResponse.json({ error: "Audit parameter weights must total 100%." }, { status: 400 });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "AI auditing is not configured yet. Add GEMINI_API_KEY to enable real call analysis, or use the sample result to explore the tool." }, { status: 503 });
    const bytes = new Uint8Array(await audio.arrayBuffer()); let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); const base64 = btoa(binary);
    const prompt = `You are a strict but fair customer-service quality auditor. Transcribe and audit this call. Detect the spoken language automatically, including mixed English, Hindi and Urdu. Judge only evidence present in the recording; write "Not evidenced" rather than inventing details. Protect personal data by replacing account numbers, phone numbers, card details and addresses with [REDACTED].\n\nScorecard: ${JSON.stringify(criteria)}\n\nReturn JSON only with this exact structure: {"overallScore": number 0-100, "language": string, "summary": string, "disposition": "Pass"|"Needs coaching"|"Critical", "sections": [{"name": string, "score": number 0-100, "weight": number, "finding": string, "evidence": string}], "criticalFailures": string[], "strengths": string[], "coaching": string[], "transcriptExcerpt": string}. The overall score must reflect the supplied weights. Mark Critical only for a material privacy, fraud, abuse, mis-selling or mandatory-compliance failure.`;
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: audio.type || "audio/mpeg", data: base64 } }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 5000 } }) });
    if (!response.ok) return NextResponse.json({ error: "The AI service could not process this recording. Try a shorter file or another supported format." }, { status: 502 });
    const payload = await response.json(); const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || ""; const result = JSON.parse(text);
    return NextResponse.json({ result: { ...result, fileName: audio.name } }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "This recording could not be audited. Please verify the file and try again." }, { status: 500 }); }
}
