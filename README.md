# Call Audit Studio

AI-assisted multilingual customer-service call auditing for individual and batch audio uploads.

## Features

- English, Hindi, Urdu and mixed-language detection
- Editable weighted QA scorecard
- CSV/JSON checklist import
- Evidence-based parameter scoring
- Critical-failure and coaching findings
- Batch dashboard and CSV export
- Up to 50 recordings per batch and 25 MB per recording
- Excel reports matching the operational audit template, plus detailed CSV and complete JSON exports

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` and add a Gemini API key and/or Groq API key.
3. Run `npm run dev`.

For Vercel, configure `GEMINI_API_KEY` for the primary provider and `GROQ_API_KEY` for automatic fallback. The optional model variables are documented in `.env.example`.

The fallback uses Groq Whisper for multilingual transcription and then Groq's language model for the structured QA audit. If a configured Groq audit model is unavailable, the server tries supported backup model IDs automatically.
