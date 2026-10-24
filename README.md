# TrialTwin — Rare Disease AI (Demo)

A full-stack demo for AI symptom analysis with a Flask backend and a Vite/React frontend.

- Backend: `flask_app.py` connects to Google's Gemma 4 API via the OpenAI-compatible endpoint. Supports SSE streaming, file uploads, multimodal attachments, and chain-of-thought (thinking) control.
- Frontend: `rareai/client` is a Vite + React UI that streams responses, shows chat history, and supports attaching small text files.
- CLI helpers: `gemma_chat.py` for Gemma 4 one-shot prompts; `openrouter_chat.py` for legacy OpenRouter testing.

Credentials are kept server-side only. The frontend proxies through `/api/*` — no API keys exposed in the browser.

## Quick Start

### Prerequisites
- Python 3.10+
- Node.js 18+ and npm

### 1) Backend

```bash
python3 -m pip install -r requirements.txt
```

Create `.env` in the repo root (see example below). At minimum set `GEMMA_API_KEY`.

```bash
python3 flask_app.py
# Server listens on http://localhost:8000
```

Example `.env` (do not commit real keys):
```
# Required — get your key at https://aistudio.google.com/app/apikey
GEMMA_API_KEY=AIza...

# Optional
GEMMA_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMMA_MODEL=gemma-4-31b-it
GEMMA_TEMPERATURE=0.7
GEMMA_MAX_TOKENS=4096
GEMMA_THINKING_LEVEL=medium   # high | medium | low | minimal (enables chain-of-thought)
GEMMA_FORCE_HTTPX=false       # force httpx fallback path

# Flask / server
PORT=8000
FLASK_DEBUG=1
UPLOAD_DIR=uploads
```

Health check:
```bash
curl http://localhost:8000/health
# → { "status": "ok", "key_present": true, "model": "gemma-4-31b-it", "provider": "gemma4" }
```

### 2) Frontend

```bash
cd rareai/client
npm install
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api/*` to the backend (`rareai/client/vite.config.ts`). Update the proxy port if you change `PORT`.

### 3) CLI (optional)

```bash
python3 gemma_chat.py "What are common causes of vertigo?"
```

Uses the same `.env` variables as the backend. Set `OUTPUT_JSON=1` to print the raw API response.

## Project Structure

```
flask_app.py          — Flask API server (chat, streaming, uploads, health)
gemma_chat.py         — CLI helper for one-shot Gemma 4 prompts
openrouter_chat.py    — Legacy CLI helper (OpenRouter / OpenAI)
rareai/client/        — Vite + React frontend
uploads/              — Saved file uploads (auto-created; configurable via UPLOAD_DIR)
requirements.txt      — Python dependencies
.env                  — Local environment (not checked in)
code/                 — Vendored developer tool repo (not required to run the app)
```

## API Reference

Base URL defaults to `http://localhost:8000`.

### Health
- `GET /health`
- Response: `{ "status": "ok", "key_present": boolean, "model": string, "provider": "gemma4" }`

### Chat (non-streaming)
- `POST /chat`
- Body (JSON):
  - `prompt?: string` — Quick single user message
  - `system?: string` — Optional system instruction
  - `messages?: { role: 'system'|'user'|'assistant', content: string }[]` — Full history
  - `model?: string` — Defaults to `GEMMA_MODEL` env var or `gemma-4-31b-it`
  - `temperature?: number`, `max_tokens?: number`
  - `thinking_level?: "high"|"medium"|"low"|"minimal"` — Enable Gemma 4 chain-of-thought
  - `attachments?: Attachment[]` (see Attachments section below)
  - `force_httpx?: boolean` — Skip SDK, use httpx directly
  - `raw?: boolean` — Return full provider JSON instead of just `content`
- Success response: `{ content: string, model: string }`
- With `raw: true`: `{ ok: true, model: string, content?: string, raw: any }`

```bash
curl -X POST http://localhost:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{
        "messages": [
          {"role":"system","content":"Be concise."},
          {"role":"user","content":"Summarize influenza symptoms."}
        ],
        "temperature": 0.3,
        "max_tokens": 300,
        "thinking_level": "low"
      }'
```

### Chat (SSE streaming)
- `POST /chat/stream`
- Same body as `/chat`. Emits Server-Sent Events:
  - `data: {"ok":true,"model":"gemma-4-31b-it","begin":true}` — session start
  - `data: {"delta":"token text"}` — repeated content chunks
  - `data: {"done":true}` — end of stream
  - `data: {"ok":false,"error":"..."}` — on error

```bash
curl -N -s http://localhost:8000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{
        "messages": [{"role":"user","content":"List causes of chronic cough"}],
        "temperature": 0.2
      }'
```

### File Uploads
- `POST /upload` (multipart/form-data, field name: `files`)
- Response: `{ ok: true, files: Attachment[] }`
- `Attachment`: `{ id: string, name: string, size: number, mimetype: string }`

```bash
curl -F 'files=@/path/to/notes.txt' http://localhost:8000/upload
```

### Download Uploaded File
- `GET /files/<id>` — Returns the original file as a download.

## Attachments

Pass `attachments` in `/chat` or `/chat/stream` as an array:
- Uploaded file: `{ "id": "<id from /upload>" }`
- Server-local path (dev/testing only): `{ "path": "/absolute/path/to/file" }`

Behavior:
- Text-like files (`.txt`, `.md`, `.csv`, `.json`, `text/*`) ≤ 512 KB are inlined as fenced code blocks.
- Images ≤ 5 MB are attached as multimodal `image_url` parts for vision-capable models (Gemma 4 is multimodal by default).
- Larger or binary files are mentioned by name/size but not inlined.

## Gemma 4 Thinking (Chain-of-Thought)

Set `thinking_level` in the request body or `GEMMA_THINKING_LEVEL` in `.env`:

| Level | Behavior |
|-------|----------|
| `high` | Maximum reasoning effort |
| `medium` | Balanced reasoning |
| `low` | Light reasoning |
| `minimal` | Minimal overhead |
| *(omit)* | Model default |

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `GEMMA_API_KEY` | — | **Required.** Google AI Studio key |
| `GEMMA_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai/` | API base URL |
| `GEMMA_MODEL` | `gemma-4-31b-it` | Model slug |
| `GEMMA_TEMPERATURE` | — | Generation temperature |
| `GEMMA_MAX_TOKENS` | — | Max output tokens |
| `GEMMA_THINKING_LEVEL` | — | Chain-of-thought level |
| `GEMMA_FORCE_HTTPX` | `false` | Skip SDK, use httpx directly |
| `PORT` | `8000` | Flask listening port |
| `FLASK_DEBUG` | — | `1` to enable debug mode |
| `UPLOAD_DIR` | `./uploads` | File upload directory |

## Troubleshooting

- **401 / credential errors**: ensure `.env` has a valid `GEMMA_API_KEY` and restart the backend.
- **Backend not reachable**: run `python3 flask_app.py`, then hit `http://localhost:8000/health`.
- **Streaming through corporate proxies**: use `/chat` (non-streaming) or set `force_httpx: true`.
- **Large files not inlined**: the server notes them by name/size but won't block the request.
- **Model not found**: verify the slug at [Google AI Studio](https://aistudio.google.com/models) and set `GEMMA_MODEL`.

## Safety & Disclaimer

This demo produces AI-generated suggestions and is **not medical advice**. Always consult healthcare professionals for diagnosis and treatment.
