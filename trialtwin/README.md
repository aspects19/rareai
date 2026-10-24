# trialtwin

Rare Disease AI

Dev quick start

- Backend (Flask):
  - From the repo root, ensure deps are installed: `python3 -m pip install -r requirements.txt`
  - Start the API server: `python3 flask_app.py` (listens on `http://localhost:8000`)

- Frontend (Vite + React):
  - `cd trialtwin/client`
  - Install deps: `npm install`
  - Run dev server: `npm run dev` (opens `http://localhost:5173`)

The frontend proxies API calls from `/api/*` to `http://localhost:8000/*` (see `trialtwin/client/vite.config.ts`). If you change the backend port or host, update that proxy accordingly.

Troubleshooting

- If the UI shows “Backend not reachable”, confirm the Flask server is running at `http://localhost:8000/health`.
- If streaming fails due to proxies, the UI falls back to a non-streaming request when possible and surfaces the error details.
