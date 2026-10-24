# TrialTwin — Rare Disease AI (Demo)

A small full‑stack demo for AI symptom analysis with a Flask backend and a Vite/React frontend.

- Backend: `flask_app.py` bridges to OpenRouter’s Chat Completions API (via the OpenAI Python SDK or httpx fallback) and supports SSE streaming, file uploads, and simple health checks.
- Frontend: `trialtwin/client` is a Vite + React UI that streams responses, shows chat history, and supports attaching small text files.
- CLI helper: `openrouter_chat.py` provides a terminal script to send a single prompt using the same environment configuration.

This project keeps credentials on the server. The frontend calls the backend (proxied to `http://localhost:8000`) — no API keys are exposed in the browser.

## Quick Start

### Prerequisites
- Python 3.10+
- Node.js 18+ and npm

### 1) Backend

- Install Python deps:
  - `python3 -m pip install -r requirements.txt`
- Create `.env` in the repo root (see example below). At minimum set `OPENROUTER_API_KEY`.
- Start the API server:
  - `python3 flask_app.py`
  - Server listens on `http://localhost:8000` by default.

Example `.env` (do not commit real keys):
```
# Required
OPENROUTER_API_KEY=sk-or-...     # or set OPENAI_API_KEY with the same value

# Optional
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-oss-120b
OPENROUTER_SITE_URL=http://localhost:5173   # sets HTTP-Referer header
OPENROUTER_APP_NAME=TrialTwin (Dev)         # sets X-Title header
OPENROUTER_FORCE_HTTPX=false                # force httpx fallback path

# Flask / server
PORT=8000
FLASK_DEBUG=1
UPLOAD_DIR=uploads
```

Health check: `curl http://localhost:8000/health` → `{ "status": "ok", "key_present": true }`

### 2) Frontend

- `cd trialtwin/client`
- `npm install`
- `npm run dev`
- Open `http://localhost:5173`.

The dev server proxies `/api/*` to the backend (see `trialtwin/client/vite.config.ts`). If you change ports, update that proxy.

### 3) CLI (optional)

- `python3 openrouter_chat.py "What are common causes of vertigo?"`
- Uses the same `.env` variables as the backend. Set `OUTPUT_JSON=1` to print raw JSON.

## Project Structure

- `flask_app.py` — Flask API server (chat, streaming, uploads, health).
- `openrouter_chat.py` — Simple CLI for one‑shot prompts.
- `trialtwin/client` — Vite + React frontend (streaming chat UI with file attachments).
- `uploads/` — Saved file uploads (created automatically; configurable via `UPLOAD_DIR`).
- `requirements.txt` — Python dependencies.
- `.env` — Local environment (not checked in).
- `code/` — A vendored developer tool repo (not required to run the app).

## API

Base URL defaults to `http://localhost:8000`.

### Health
- `GET /health`
- Response: `{ "status": "ok", "key_present": boolean }`

### Chat (non‑streaming)
- `POST /chat`
- Body (JSON):
  - `prompt?: string` — Quick way to send a single user message
  - `system?: string` — Optional system instruction
  - `messages?: { role: 'system'|'user'|'assistant', content: string }[]` — Full chat history
  - `model?: string` — Defaults to `openai/gpt-oss-120b`
  - `temperature?: number`, `max_tokens?: number`
  - `attachments?: Attachment[]` (see “Attachments”)
  - `provider?: { order?: string[]; allow_fallbacks?: boolean }` — OpenRouter routing hints
  - `route?: object` — Advanced provider routing metadata
  - `force_httpx?: boolean` — Force httpx fallback
  - `raw?: boolean` — If true, returns full provider JSON
- Success response (default): `{ content: string }`.
- With `raw: true`: `{ ok: true, content?: string, raw: any }`.

Example:
```
curl -X POST http://localhost:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{
        "messages": [
          {"role":"system","content":"Be concise."},
          {"role":"user","content":"Summarize influenza symptoms."}
        ],
        "temperature": 0.3,
        "max_tokens": 300
      }'
```

### Chat (SSE streaming)
- `POST /chat/stream` (Server‑Sent Events)
- Emits lines like:
  - `data: {"ok":true,"model":"...","begin":true}` (start)
  - `data: {"delta":"text chunk"}` (repeated)
  - `data: {"done":true}` (end)
- On error the server emits: `data: {"ok":false, "error":"..."}`

Example (terminal):
```
curl -N -s http://localhost:8000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{
        "messages": [
          {"role":"user","content":"List causes of chronic cough"}
        ],
        "temperature": 0.2
      }'
```

### File Uploads
- `POST /upload` (multipart/form‑data)
  - Field name: `files` (can be multiple)
- Response: `{ ok: true, files: Attachment[] }`
- `Attachment` object:
  - `{ id: string, name: string, size: number, mimetype: string }`

Example:
```
curl -F 'files=@/path/to/notes.txt' http://localhost:8000/upload
# → { "ok": true, "files": [{"id":"...","name":"notes.txt", ...}] }
```

### Download Uploaded File
- `GET /files/<id>` — Returns the original file as an attachment.

## Attachments

Pass `attachments` to `/chat` or `/chat/stream` as an array of objects. Each object can be either:
- An uploaded file reference: `{ id: string }` from `/upload` (the server resolves metadata), or
- A local file path (server‑side only): `{ path: "/absolute/or/relative/path" }` (for local testing only).

Behavior:
- Small text‑like files (e.g., `.txt`, `.md`, `.csv`, `.json`, `text/*`, `application/json`) are inlined directly into the last user message as a fenced code block (size limits apply, default ~512 KB).
- Images under 5 MB are attached as multimodal parts for models that support images (e.g., `gpt-4o`, `gpt-4.1`, `-vl`, etc.).
- Larger or non‑text files are noted by filename and size, but not inlined.

## Configuration

Environment variables (all optional unless noted):
- `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) — Required. Your OpenRouter key.
- `OPENROUTER_BASE_URL` — Default `https://openrouter.ai/api/v1`.
- `OPENROUTER_MODEL` — Default `openai/gpt-oss-120b`.
- `OPENROUTER_SITE_URL` — Sent as `HTTP-Referer` header (recommended by OpenRouter).
- `OPENROUTER_APP_NAME` — Sent as `X-Title` header.
- `OPENROUTER_FORCE_HTTPX` — `true/false` to force httpx path.
- `PORT` — Flask port (default `8000`).
- `FLASK_DEBUG` — `1` to enable Flask debug.
- `UPLOAD_DIR` — Directory to store uploads (default `uploads/`).

Notes:
- The backend mirrors `OPENROUTER_API_KEY` and `OPENAI_API_KEY` so either name works.
- For provider routing, you can pass `provider.order` (e.g., `["openai","google"]`) and `provider.allow_fallbacks` in the request body; you can also pass a `route` object for advanced rules.

## Frontend Notes

- The UI streams from `/api/chat/stream` and shows incremental tokens.
- If streaming fails (e.g. proxies), it attempts a non‑streaming fallback.
- A health banner appears if the backend is unreachable or if the server is missing credentials.
- The UI attaches files with `/api/upload` then sends attachment references to the chat endpoint.

## Troubleshooting

- 401 / credential errors: ensure `.env` has a valid `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) and restart the backend.
- Backend not reachable: run `python3 flask_app.py` and visit `http://localhost:8000/health`.
- Streaming through corporate proxies: use the non‑streaming `/chat` endpoint or the UI’s built‑in fallback.
- Large files won’t inline; the server will note them by name and size.

## Safety & Disclaimer

This demo produces AI‑generated suggestions and is not medical advice. Always consult healthcare professionals for diagnosis and treatment.

