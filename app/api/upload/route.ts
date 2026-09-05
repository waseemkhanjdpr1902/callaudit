import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/x-m4a", "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac",
  "application/ogg",
];

export async function POST(request: Request) {
  if (!process.env.BLOB_STORE_ID || !process.env.BLOB_WEBHOOK_PUBLIC_KEY) {
    return NextResponse.json(
      { error: "Large-file upload is not configured. Connect a Vercel Blob store to this project for Production." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as HandleUploadPresignedBody;
    const response = await handleUploadPresigned({
      body,
      request,
      webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY,
      getSignedToken: async (pathname, clientPayload) => {
        const metadata = JSON.parse(clientPayload || "{}") as { size?: number; type?: string };
        if (!pathname.startsWith("call-audits/")) throw new Error("Invalid upload path.");
        if (!metadata.size || metadata.size > MAX_AUDIO_BYTES) throw new Error("Audio files must be 25 MB or smaller.");
        if (metadata.type && !AUDIO_TYPES.includes(metadata.type) && !metadata.type.startsWith("audio/")) throw new Error("Unsupported audio format.");
        const validUntil = Date.now() + 15 * 60 * 1000;
        return {
          token: await issueSignedToken({
            pathname,
            operations: ["put"],
            allowedContentTypes: AUDIO_TYPES,
            maximumSizeInBytes: MAX_AUDIO_BYTES,
            validUntil,
          }),
          urlOptions: {
            allowedContentTypes: AUDIO_TYPES,
            maximumSizeInBytes: MAX_AUDIO_BYTES,
            validUntil,
            tokenPayload: JSON.stringify({ size: metadata.size, type: metadata.type }),
          },
        };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(response);
  } catch (error) {
    console.error("[upload] token request failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload could not be started." }, { status: 400 });
  }
}
