export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages?: ChatMessage[];
  prompt?: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  attachments?: AttachmentRef[];
}

export interface ChatResponse {
  content?: string;
  ok?: boolean;
  error?: string;
  raw?: unknown;
}

export interface StreamHandlers {
  onStart?: (meta?: unknown) => void;
  onDelta?: (text: string) => void;
  onError?: (error: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}

export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  mimetype: string;
}

export interface UploadResponse {
  ok: boolean;
  files?: AttachmentRef[];
  error?: string;
}

export async function uploadFiles(files: File[]): Promise<UploadResponse> {
  if (!files.length) return { ok: false, error: 'No files to upload' };
  const form = new FormData();
  for (const f of files) form.append('files', f);
  let res: Response;
  try {
    res = await fetch('/api/upload', { method: 'POST', body: form });
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error' };
  }
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok || !data?.ok) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, files: (data.files || []) as AttachmentRef[] };
}

// Post to backend STREAM endpoint via Vite proxy (/api -> http://localhost:8000)
// Accumulates Server-Sent Events (SSE) into a single content string for current UI usage.
export async function postChat(body: ChatRequest): Promise<ChatResponse> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') || '';

  // If server responded with JSON (e.g., validation error), return that
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (data as any)?.error || `HTTP ${res.status}` };
    }
    return data as ChatResponse;
  }

  if (!res.body) {
    return { ok: false, error: 'No response body from stream' };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';
  let error: string | undefined;

  // Helper to process as many SSE events as possible from the buffer.
  // Handles both \n\n and \r\n\r\n delimiters and tolerates a final unterminated event.
  const drainBuffer = () => {
    // Normalize Windows newlines to\n for delimiter detection while preserving JSON strings
    // We only use normalized copy for finding event boundaries
    let progressed = false;
    while (true) {
      // Find the first event boundary (either \n\n or \r\n\r\n)
      const idxLF = buffer.indexOf('\n\n');
      const idxCRLF = buffer.indexOf('\r\n\r\n');
      let splitIndex = -1;
      if (idxLF !== -1 && idxCRLF !== -1) splitIndex = Math.min(idxLF, idxCRLF);
      else splitIndex = idxLF !== -1 ? idxLF : idxCRLF;
      if (splitIndex === -1) break;

      const chunk = buffer.slice(0, splitIndex);
      // Remove delimiter as well (2 or 4 chars)
      buffer = buffer.slice(splitIndex + (buffer.startsWith('\r\n', splitIndex) ? 4 : 2));

      const lines = chunk.split(/\r?\n/);
      const dataLine = lines.find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice('data:'.length).trim();
      if (!jsonStr || jsonStr === '[DONE]') { progressed = true; continue; }
      try {
        const obj = JSON.parse(jsonStr) as any;
        if (obj && typeof obj === 'object') {
          if (obj.error) {
            error = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
          }
          if (obj.delta) {
            acc += String(obj.delta);
          }
        }
      } catch {
        // Ignore malformed JSON lines
      }
      progressed = true;
    }
    return progressed;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process as many complete SSE events as available
      drainBuffer();
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Stream read failed' };
  }

  // Process any final unterminated event in the buffer (best-effort)
  if (buffer.trim().startsWith('data:')) {
    const line = buffer.trim();
    const jsonStr = line.slice('data:'.length).trim();
    if (jsonStr && jsonStr !== '[DONE]') {
      try {
        const obj = JSON.parse(jsonStr) as any;
        if (obj?.delta) acc += String(obj.delta);
        if (obj?.error) error = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
      } catch {
        // ignore
      }
    }
  }

  return error ? { ok: false, error } : { ok: true, content: acc };
}

// True streaming API: invokes handlers per incoming SSE chunk
export async function streamChat(body: ChatRequest, handlers: StreamHandlers): Promise<void> {
  const { onStart, onDelta, onError, onDone, signal } = handlers;

  let res: Response;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    onError?.(e?.message || 'Network error');
    onDone?.();
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    // Fallback: server returned JSON (e.g., error or non-stream path)
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      onError?.((data as any)?.error || `HTTP ${res.status}`);
    } else {
      onStart?.(data);
      const text = (data as any)?.content ?? '';
      if (text) onDelta?.(String(text));
    }
    onDone?.();
    return;
  }

  if (!res.body) {
    onError?.('No response body from stream');
    onDone?.();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const drainBuffer = () => {
    let progressed = false;
    while (true) {
      const idxLF = buffer.indexOf('\n\n');
      const idxCRLF = buffer.indexOf('\r\n\r\n');
      let idx = -1;
      if (idxLF !== -1 && idxCRLF !== -1) idx = Math.min(idxLF, idxCRLF);
      else idx = idxLF !== -1 ? idxLF : idxCRLF;
      if (idx === -1) break;

      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer.startsWith('\r\n', idx) ? 4 : 2));

      const lines = chunk.split(/\r?\n/);
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice('data:'.length).trim();
      if (!jsonStr || jsonStr === '[DONE]') { progressed = true; continue; }

      try {
        const obj = JSON.parse(jsonStr) as any;
        if (obj?.begin) handlers.onStart?.(obj);
        if (obj?.error) handlers.onError?.(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
        if (obj?.delta) handlers.onDelta?.(String(obj.delta));
        if (obj?.done) handlers.onDone?.();
      } catch {
        // ignore malformed json
      }
      progressed = true;
    }
    return progressed;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Drain any complete events currently in the buffer
      drainBuffer();
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      // Swallow abort as a normal end
      onDone?.();
      return;
    }
    onError?.(e?.message || 'Stream read failed');
  }

  // Process any final unterminated event
  if (buffer.trim().startsWith('data:')) {
    const line = buffer.trim();
    const jsonStr = line.slice('data:'.length).trim();
    if (jsonStr && jsonStr !== '[DONE]') {
      try {
        const obj = JSON.parse(jsonStr) as any;
        if (obj?.begin) onStart?.(obj);
        if (obj?.error) onError?.(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
        if (obj?.delta) onDelta?.(String(obj.delta));
      } catch {
        // ignore
      }
    }
  }

  onDone?.();
}
