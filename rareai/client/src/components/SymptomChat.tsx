import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Stethoscope, Brain, User, AlertTriangle,
  Paperclip, X, Copy, Check, RotateCcw, ArrowUp, Square, ImageIcon,
} from 'lucide-react';
import { streamChat, uploadFiles, postChat, type AttachmentRef } from '../api';
import Markdown from './Markdown';
import { cn } from '../utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: Date;
  streaming?: boolean;
  /** image preview urls attached by the user (data: URLs, display only) */
  imagePreviews?: string[];
}

type Attachment = AttachmentRef & { error?: string; preview?: string };

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM =
  'You are RareAI, a compassionate medical AI assistant specialising in symptom analysis and rare diseases. ' +
  'When analysing symptoms, ALWAYS suggest at least three possible diseases or conditions ordered from most ' +
  'to least likely. Format your response using markdown: highlight the most likely diagnosis with a ' +
  '**bold heading**, then list the others as numbered entries. For each condition include: likelihood ' +
  'reasoning, key distinguishing symptoms, and recommended next steps. ' +
  'Always end with a disclaimer reminding the user to consult a qualified healthcare professional.';

const SUGGESTIONS = [
  'What could cause persistent fatigue and joint pain?',
  'I have unusual skin rashes and photosensitivity.',
  'Recurring headaches with visual disturbances?',
  "What are early symptoms of Wilson's disease?",
];

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(d: Date) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isImageFile(f: File) {
  return ACCEPTED_IMAGE_TYPES.includes(f.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name);
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ─── WaveLoader — shown immediately after send while waiting for first token ──

function WaveLoader() {
  return (
    <div className="flex items-end gap-[3px] h-5 px-1" aria-label="RareAI is thinking">
      {[0, 1, 2, 3, 4].map(i => (
        <div
          key={i}
          className="w-[3px] rounded-full bg-gradient-to-t from-teal-500 to-indigo-400"
          style={{
            height: '100%',
            animation: `waveBar 0.6s ease-in-out ${i * 0.1}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

// ─── CopyButton ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* ignore */ }
  };
  return (
    <button
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy response'}
      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/70
                 transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-emerald-500" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── SuggestionChip ───────────────────────────────────────────────────────────

function SuggestionChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left px-4 py-3 rounded-2xl border border-border/70
                 bg-background/60 hover:bg-muted/50 hover:border-border
                 transition-all text-sm text-foreground/75 hover:text-foreground
                 shadow-sm hover:shadow-md leading-snug"
    >
      {label}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SymptomChat() {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [backendOk, setBackendOk]     = useState<boolean | null>(null);
  const [keyPresent, setKeyPresent]   = useState<boolean | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [dragOver, setDragOver]       = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const dropZoneRef    = useRef<HTMLDivElement>(null);
  const abortRef       = useRef<AbortController | null>(null);

  // ── health check ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    fetch('/api/health').then(async r => {
      if (!live) return;
      setBackendOk(r.ok);
      try { const d = await r.json(); setKeyPresent(Boolean(d?.key_present)); }
      catch { setKeyPresent(null); }
    }).catch(() => { if (live) setBackendOk(false); });
    return () => { live = false; };
  }, []);

  // ── scroll ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── auto-resize textarea ───────────────────────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [input]);

  // ── file processing helper ─────────────────────────────────────────────────
  const processFiles = useCallback(async (files: File[]) => {
    const slots  = Math.max(0, 5 - attachments.length);
    const toAdd  = files.slice(0, slots);
    if (!toAdd.length) return;

    // Build local previews for images immediately (feels instant)
    const previews: Record<string, string> = {};
    await Promise.all(
      toAdd.filter(isImageFile).map(async f => {
        try { previews[f.name] = await readAsDataURL(f); } catch { /* ignore */ }
      })
    );

    setPendingUploads(n => n + 1);
    uploadFiles(toAdd)
      .then(res => {
        setAttachments(prev => [
          ...prev,
          ...(res.ok && res.files
            ? res.files.map(att => ({ ...att, preview: previews[att.name] }))
            : toAdd.map(f => ({
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                name: f.name, size: f.size,
                mimetype: f.type || 'application/octet-stream',
                error: res.error ?? 'Upload failed',
                preview: previews[f.name],
              }))),
        ]);
      })
      .finally(() => setPendingUploads(n => n - 1));
  }, [attachments.length]);

  // ── drag & drop ───────────────────────────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = (e: React.DragEvent) => { if (!dropZoneRef.current?.contains(e.relatedTarget as Node)) setDragOver(false); };
  const onDrop      = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await processFiles(files);
  };

  // ── send ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streamingId || pendingUploads > 0) return;

    const savedAttachments = [...attachments];
    const imagePreviews    = savedAttachments.filter(a => a.preview).map(a => a.preview!);

    const userMsg: Message = {
      id: crypto.randomUUID(), role: 'user', content: text,
      ts: new Date(), imagePreviews,
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const history = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    // Insert assistant placeholder immediately — WaveLoader shown until first token
    const aiId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: aiId, role: 'assistant', content: '', ts: new Date(), streaming: true }]);
    setStreamingId(aiId);

    abortRef.current = new AbortController();

    await streamChat(
      {
        system: SYSTEM,
        messages: [...history, { role: 'user', content: text }],
        attachments: savedAttachments.map(({ id, name, size, mimetype }) => ({ id, name, size, mimetype })),
        temperature: 0.3,
        max_tokens: 3000,
      },
      {
        signal: abortRef.current.signal,
        onDelta: delta => {
          setMessages(prev =>
            prev.map(m => m.id === aiId ? { ...m, content: m.content + delta } : m)
          );
        },
        onError: async err => {
          const errMsg = String(err ?? 'Unknown error');
          const isNetwork = /Network error|Failed to fetch|TypeError/.test(errMsg);

          if (!isNetwork) {
            try {
              const resp = await postChat({
                system: SYSTEM,
                messages: [...history, { role: 'user', content: text }],
                attachments: savedAttachments.map(({ id, name, size, mimetype }) => ({ id, name, size, mimetype })),
                temperature: 0.3, max_tokens: 3000,
              });
              if (resp.ok && resp.content) {
                setMessages(prev =>
                  prev.map(m => m.id === aiId ? { ...m, content: resp.content!, streaming: false } : m)
                );
                setStreamingId(null);
                return;
              }
            } catch { /* fall through */ }
          }

          const note = /401|GEMMA_API_KEY|Missing key/i.test(errMsg)
            ? 'Set a valid `GEMMA_API_KEY` in `.env` and restart the backend.'
            : 'Ensure the backend is running: `python3 flask_app.py`';
          setMessages(prev =>
            prev.map(m => m.id === aiId
              ? { ...m, content: `**Error:** ${errMsg}\n\n${note}`, streaming: false }
              : m)
          );
          if (isNetwork) setBackendOk(false);
          setStreamingId(null);
        },
        onDone: () => {
          setMessages(prev =>
            prev.map(m => m.id === aiId ? { ...m, streaming: false } : m)
          );
          setStreamingId(null);
        },
      }
    );
  }, [input, messages, attachments, streamingId, pendingUploads]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    setMessages(prev => prev.map(m => m.id === streamingId ? { ...m, streaming: false } : m));
    setStreamingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) processFiles(files);
    e.target.value = '';
  };

  const canSend = input.trim().length > 0 && !streamingId && pendingUploads === 0;

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div
      ref={dropZoneRef}
      className="flex flex-col h-screen bg-background relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ── Drag-over overlay ───────────────────────────────────────────── */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3
                        bg-indigo-500/10 border-2 border-dashed border-indigo-400
                        backdrop-blur-sm pointer-events-none rounded-none">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/20 border-2 border-indigo-400
                          flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-indigo-500" />
          </div>
          <p className="text-indigo-600 dark:text-indigo-300 font-semibold text-lg">Drop image to attach</p>
          <p className="text-indigo-500/70 text-sm">Supports JPEG, PNG, GIF, WebP</p>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex-none z-20 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-9 h-9 rounded-xl
                            bg-gradient-to-br from-teal-400 to-indigo-500 shadow">
              <Stethoscope className="w-[18px] h-[18px] text-white" />
              <span className={cn(
                'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-background',
                backendOk === null ? 'bg-amber-400 animate-pulse' :
                backendOk ? 'bg-emerald-400' : 'bg-red-500'
              )} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold tracking-tight">RareAI</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full
                                 bg-indigo-100 text-indigo-600
                                 dark:bg-indigo-900/50 dark:text-indigo-300 leading-none">
                  Gemma 4
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">Rare Disease AI Analyzer</p>
            </div>
          </div>

          {messages.length > 0 && (
            <button
              onClick={() => { setMessages([]); setStreamingId(null); abortRef.current?.abort(); }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground
                         border border-border/60 rounded-lg px-3 py-1.5 hover:bg-muted/60 transition-all"
            >
              <RotateCcw className="w-3 h-3" />
              New chat
            </button>
          )}
        </div>
      </header>

      {/* ── Alerts ──────────────────────────────────────────────────────── */}
      {backendOk === false && (
        <div className="flex-none px-4 pt-3 max-w-2xl mx-auto w-full">
          <div className="flex gap-3 items-start rounded-xl border border-red-200 dark:border-red-900/40
                          bg-red-50 dark:bg-red-950/20 px-4 py-3 text-xs text-red-700 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Backend unreachable. Run <code className="font-mono">python3 flask_app.py</code> from the project root.</p>
          </div>
        </div>
      )}
      {backendOk === true && keyPresent === false && (
        <div className="flex-none px-4 pt-3 max-w-2xl mx-auto w-full">
          <div className="flex gap-3 items-start rounded-xl border border-amber-200 dark:border-amber-800/40
                          bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>No API key. Set <code className="font-mono">GEMMA_API_KEY</code> in <code className="font-mono">.env</code> and restart.</p>
          </div>
        </div>
      )}

      {/* ── Messages ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-full gap-8 px-4 py-12">
            <div className="text-center space-y-3">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-400 to-indigo-500
                              flex items-center justify-center mx-auto shadow-lg">
                <Brain className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight">How can I help you today?</h2>
              <p className="text-muted-foreground text-sm max-w-xs leading-relaxed">
                Describe your symptoms and I'll suggest the most likely conditions,
                starting with rare diseases.
              </p>
              <p className="text-xs text-muted-foreground/60">
                You can also drag &amp; drop images anywhere on this page
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
              {SUGGESTIONS.map(s => (
                <SuggestionChip key={s} label={s} onClick={() => sendMessage(s)} />
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-4 py-6 space-y-0.5">
            {messages.map((msg, i) => {
              const isUser       = msg.role === 'user';
              const firstInGroup = i === 0 || messages[i - 1].role !== msg.role;
              const isStreaming  = msg.id === streamingId;
              const waitingForFirstToken = isStreaming && msg.content === '';

              return (
                <div
                  key={msg.id}
                  className={cn(
                    'flex gap-3',
                    isUser ? 'flex-row-reverse' : 'flex-row',
                    firstInGroup ? 'mt-6' : 'mt-0.5'
                  )}
                >
                  {/* Avatar */}
                  <div className={cn('shrink-0 w-8 h-8 mt-0.5', !firstInGroup && 'invisible')}>
                    {isUser ? (
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-400 to-blue-500
                                      flex items-center justify-center shadow-sm">
                        <User className="w-4 h-4 text-white" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-indigo-500
                                      flex items-center justify-center shadow-sm">
                        <Brain className="w-4 h-4 text-white" />
                      </div>
                    )}
                  </div>

                  {/* Content column */}
                  <div className={cn(
                    'group min-w-0 flex-1 flex flex-col',
                    isUser ? 'items-end' : 'items-start'
                  )}>
                    {firstInGroup && (
                      <div className="flex items-baseline gap-1.5 mb-1.5 px-1">
                        <span className="text-[11px] font-semibold text-foreground/70 select-none">
                          {isUser ? 'You' : 'RareAI'}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 select-none">
                          {fmtTime(msg.ts)}
                        </span>
                      </div>
                    )}

                    {/* Bubble */}
                    <div className={cn(
                      'relative max-w-[90%] sm:max-w-[80%] rounded-2xl text-sm',
                      isUser
                        ? 'bg-gradient-to-br from-sky-500 to-blue-600 text-white px-4 py-2.5 rounded-tr-sm shadow-sm'
                        : 'bg-card border border-border/50 px-4 py-3 rounded-tl-sm shadow-sm',
                      isStreaming && !waitingForFirstToken && 'ring-1 ring-primary/15'
                    )}>
                      {isUser ? (
                        <>
                          {/* Image previews in user bubble */}
                          {msg.imagePreviews && msg.imagePreviews.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2">
                              {msg.imagePreviews.map((src, idx) => (
                                <img
                                  key={idx}
                                  src={src}
                                  alt="attachment"
                                  className="max-h-40 max-w-[200px] rounded-xl object-cover border border-white/20"
                                />
                              ))}
                            </div>
                          )}
                          <p className="whitespace-pre-wrap leading-[1.7] break-words">{msg.content}</p>
                        </>
                      ) : waitingForFirstToken ? (
                        /* ── Wave loader — shown immediately, before first token ── */
                        <div className="py-1">
                          <WaveLoader />
                        </div>
                      ) : (
                        <Markdown content={msg.content} streaming={isStreaming} />
                      )}
                    </div>

                    {/* Footer: copy + disclaimer */}
                    {!isUser && !isStreaming && msg.content && (
                      <div className="flex items-center gap-1 mt-1.5 px-1">
                        <CopyButton text={msg.content} />
                        <span className="text-[10px] text-muted-foreground/40 flex items-center gap-1 ml-0.5">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          AI-generated — not medical advice
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Input ───────────────────────────────────────────────────────── */}
      <div className="flex-none px-4 pb-5 pt-3 bg-background border-t border-border/40">
        <div className="max-w-2xl mx-auto space-y-2">

          {/* Attachment chips / image previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {attachments.map(a => (
                <div key={a.id} className="relative group/chip">
                  {a.preview ? (
                    /* image thumbnail chip */
                    <div className={cn(
                      'relative rounded-xl overflow-hidden border-2 transition-colors',
                      a.error ? 'border-red-400' : 'border-border/50'
                    )}>
                      <img src={a.preview} alt={a.name}
                           className="h-16 w-16 object-cover" />
                      {a.error && (
                        <div className="absolute inset-0 bg-red-500/60 flex items-center justify-center">
                          <AlertTriangle className="w-5 h-5 text-white" />
                        </div>
                      )}
                      <button
                        aria-label={`Remove ${a.name}`}
                        onClick={() => setAttachments(p => p.filter(x => x.id !== a.id))}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white
                                   flex items-center justify-center opacity-0 group-hover/chip:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    /* file chip */
                    <span className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium',
                      a.error
                        ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400'
                        : 'border-border/70 bg-muted/60 text-foreground/80'
                    )}>
                      <Paperclip className="w-3 h-3 shrink-0" />
                      <span className="max-w-[100px] truncate">{a.name}</span>
                      <span className="text-muted-foreground font-normal">
                        {Math.max(1, Math.round(a.size / 1024))} KB
                      </span>
                      <button
                        aria-label={`Remove ${a.name}`}
                        onClick={() => setAttachments(p => p.filter(x => x.id !== a.id))}
                        className="ml-0.5 rounded hover:bg-black/10 dark:hover:bg-white/15 p-0.5 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  )}
                </div>
              ))}
              {pendingUploads > 0 && (
                <div className="h-16 w-16 rounded-xl border-2 border-dashed border-border/50
                                flex items-center justify-center bg-muted/30">
                  <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent
                                  rounded-full animate-spin" />
                </div>
              )}
            </div>
          )}

          {/* Input pill */}
          <div className={cn(
            'flex items-end rounded-2xl border bg-background shadow-sm transition-all',
            streamingId
              ? 'border-primary/30 ring-1 ring-primary/15'
              : 'border-border/70 focus-within:border-border focus-within:shadow-md'
          )}>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder={streamingId ? 'RareAI is responding…' : 'Describe your symptoms… or drop an image'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!!streamingId}
              className={cn(
                'flex-1 resize-none bg-transparent px-4 py-3.5 text-sm leading-relaxed',
                'placeholder:text-muted-foreground/50 focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-40',
                'min-h-[52px] max-h-[180px] overflow-y-auto'
              )}
            />

            <div className="flex items-end gap-1 px-2 pb-2.5">
              {/* Attach (file + image) */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!!streamingId || attachments.length >= 5}
                title="Attach file or image (max 5)"
                className="p-2 rounded-xl text-muted-foreground hover:text-foreground
                           hover:bg-muted/70 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              {/* Send / Stop */}
              {streamingId ? (
                <button
                  onClick={stopStreaming}
                  title="Stop generating"
                  className="p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors shadow-sm"
                >
                  <Square className="w-4 h-4 fill-current" />
                </button>
              ) : (
                <button
                  onClick={() => sendMessage()}
                  disabled={!canSend}
                  title="Send (Enter)"
                  className={cn(
                    'p-2 rounded-xl transition-all shadow-sm',
                    canSend
                      ? 'bg-gradient-to-br from-teal-500 to-indigo-500 hover:from-teal-600 hover:to-indigo-600 text-white'
                      : 'bg-muted text-muted-foreground/50 cursor-not-allowed'
                  )}
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <p className="text-center text-[10px] text-muted-foreground/50 select-none">
            Enter to send · Shift+Enter for new line · drag &amp; drop images · 5 attachments max
          </p>
        </div>
      </div>

      {/* Hidden file input — accepts images + text files */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept="image/*,.txt,.md,.csv,.json,text/*,application/json"
        onChange={handleFilesSelected}
      />
    </div>
  );
}
