import { useState, useRef, useEffect } from "react";
import { Button } from "./Button";
import { Textarea } from "./TextArea";
import { Stethoscope, Send, Brain, User, AlertTriangle, Paperclip, X } from "lucide-react";
import { streamChat, uploadFiles, postChat, type AttachmentRef } from "../api";
import Markdown from "./Markdown";
import ChatBubble from "./ChatBubble";
import { cn } from "../utils";
import { Alert, AlertDescription, AlertTitle } from "./Alert";

interface Message {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: Date;
}

const SymptomChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  type Attachment = AttachmentRef & { error?: string };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Lightweight backend health check on mount
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { method: 'GET' });
        if (!cancelled) {
          setBackendOk(res.ok);
          try {
            const data = await res.json();
            setKeyPresent(Boolean((data as any)?.key_present));
          } catch {
            setKeyPresent(null);
          }
        }
      } catch {
        if (!cancelled) setBackendOk(false);
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  const sendMessage = async () => {
    if (!input.trim()) return;
    if (pendingUploads > 0) return; // wait until files finish uploading

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setAttachments([]);

    // Build chat history for the backend
    const system = 'You are a medical AI assistant specializing in analyzing symptoms and suggesting possible diagnoses, with a focus on rare diseases. Provide clear, helpful responses but always remind users to consult healthcare professionals. Be conversational and supportive.';
    const history = messages.map(m => ({
      role: m.type === 'ai' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    // Create placeholder AI message to stream into
    const aiId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: aiId, type: 'ai', content: '', timestamp: new Date() }]);

    // Stream and update AI message incrementally
    await streamChat({
      system,
      messages: [...history, { role: 'user', content: userMessage.content }],
      attachments: attachments.map(({ id, name, size, mimetype }) => ({ id, name, size, mimetype })),
      temperature: 0.3,
      max_tokens: 3000,
    }, {
      onDelta: (delta) => {
        setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: m.content + delta } : m));
      },
      onError: async (err) => {
        const msg = (err && typeof err === 'string') ? err : 'Unknown error';
        // Attempt non-stream fallback if server responded but not with SSE
        const looksNetwork = /Network error|Failed to fetch|TypeError: fetch/i.test(String(msg));
        if (!looksNetwork) {
          try {
            const resp = await postChat({
              system,
              messages: [...history, { role: 'user', content: userMessage.content }],
              attachments: attachments.map(({ id, name, size, mimetype }) => ({ id, name, size, mimetype })),
              temperature: 0.3,
              max_tokens: 3000,
            });
            if (resp.ok && resp.content) {
              setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: resp.content! } : m));
              return;
            }
          } catch {
            // ignore and fall through to error message
          }
        }
        // Improve guidance for common credential error
        const credIssue = /401|User not found|Missing OPENROUTER_API_KEY|OPENAI_API_KEY/i.test(String(msg));
        const guidance = credIssue
          ? 'The server API key appears invalid or missing. Set a valid OPENROUTER_API_KEY in .env and restart the backend.'
          : 'If developing locally, ensure the backend server is running on http://localhost:8000.';
        setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: `Error: ${msg}. ${guidance}` } : m));
        if (looksNetwork) setBackendOk(false);
      },
      onDone: () => {
        setIsLoading(false);
      },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startNewChat = () => {
    setMessages([]);
    setInput("");
  };

  const triggerFilePicker = () => fileInputRef.current?.click();

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const MAX_FILES = 3;
    const remainingSlots = Math.max(0, MAX_FILES - attachments.length);
    const toAdd = files.slice(0, remainingSlots);

    if (toAdd.length === 0) {
      e.target.value = "";
      return;
    }

    setPendingUploads((n) => n + 1);
    uploadFiles(toAdd)
      .then((res) => {
        if (res.ok && res.files) {
          setAttachments((prev) => [...prev, ...res.files!]);
        } else {
          // If upload fails, add placeholders with error for each attempted file
          setAttachments((prev) => [
            ...prev,
            ...toAdd.map((f) => ({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: f.name,
              size: f.size,
              mimetype: f.type || 'application/octet-stream',
              error: res.error || 'Upload failed',
            })),
          ]);
        }
      })
      .finally(() => setPendingUploads((n) => n - 1));

    // reset input so the same file can be re-selected later
    e.target.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Content stays as typed; attachments are sent as metadata and appended server-side

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-3">
            <div className="flex items-center justify-center w-8 h-8 bg-gradient-primary rounded-lg">
              <Stethoscope className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">MedAI</h1>
              <p className="text-xs text-muted-foreground">AI Symptom Analyzer</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={startNewChat}>
            New Chat
          </Button>
        </div>
      </header>

      {/* No API key needed: backend holds credentials */}

      {/* Backend availability banner */}
      {backendOk === false && (
        <div className="px-4 pt-3">
          <div className="max-w-3xl mx-auto">
            <Alert variant="destructive">
              <AlertTitle>Backend not reachable</AlertTitle>
              <AlertDescription>
                The app cannot reach the API server at <code>http://localhost:8000</code>.
                Start it with <code>python3 flask_app.py</code> from the project root, or update the proxy in <code>trialtwin/client/vite.config.ts</code>.
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}
      {backendOk && keyPresent === false && (
        <div className="px-4 pt-3">
          <div className="max-w-3xl mx-auto">
            <Alert variant="destructive">
              <AlertTitle>Server credentials missing</AlertTitle>
              <AlertDescription>
                The backend is running, but no valid API key is configured. Set <code>OPENROUTER_API_KEY</code> (or <code>OPENAI_API_KEY</code>) in <code>.env</code> and restart the backend.
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4 max-w-md px-4">
              <div className="w-16 h-16 bg-gradient-primary rounded-full flex items-center justify-center mx-auto">
                <Brain className="h-8 w-8 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-foreground">How can I help with your symptoms?</h2>
              <p className="text-muted-foreground">
                Describe your symptoms and I'll help analyze them for potential diagnoses.
              </p>
              
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-6 px-4" role="list" aria-label="Chat transcript">
            {messages.map((message, i) => {
              const prev = i > 0 ? messages[i - 1] : undefined;
              const isFirstInGroup = !prev || prev.type !== message.type;
              const isUser = message.type === 'user';
              const rowDir = isUser ? 'flex-row-reverse' : 'flex-row';
              const alignItems = isUser ? 'items-end' : 'items-start';
              const groupMargin = isFirstInGroup ? 'mt-6' : 'mt-2';
              const label = isUser ? 'You' : 'MedAI';
              return (
                <div
                  key={message.id}
                  role="listitem"
                  aria-label={isUser ? 'Your message' : 'Assistant message'}
                  className={cn('flex gap-3', rowDir, groupMargin)}
                >
                  {/* Avatar column (reserve space even when not first to keep alignment) */}
                  <div className={cn('flex-shrink-0 w-8 h-8', isFirstInGroup ? '' : 'invisible')}
                       aria-hidden={!isFirstInGroup}
                  >
                    {isUser ? (
                      <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
                        <User className="h-4 w-4 text-primary-foreground" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 bg-gradient-primary rounded-full flex items-center justify-center">
                        <Brain className="h-4 w-4 text-white" />
                      </div>
                    )}
                  </div>
                  {/* Content column */}
                  <div className={cn('min-w-0 flex-1 flex flex-col', alignItems)}>
                    {isFirstInGroup && (
                      <div className="sender-label mb-1 select-none">
                        {label}
                      </div>
                    )}
                    <ChatBubble role={isUser ? 'user' : 'assistant'} firstInGroup={isFirstInGroup}>
                      <Markdown
                        content={message.content}
                        className="prose prose-sm max-w-none whitespace-pre-wrap"
                      />
                    </ChatBubble>
                    {!isUser && (
                      <div className="text-xs text-muted-foreground mt-2">
                        <AlertTriangle className="h-3 w-3 inline mr-1" />
                        This is AI-generated content. Always consult healthcare professionals for medical advice.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {isLoading && (
              <div className={cn('flex gap-3 mt-6 flex-row')}>
                <div className="w-8 h-8 bg-gradient-primary rounded-full flex items-center justify-center">
                  <Brain className="h-4 w-4 text-white" />
                </div>
                <div className="min-w-0 flex-1 flex flex-col items-start">
                  <div className="sender-label mb-1 select-none">MedAI</div>
                  <ChatBubble role="assistant" skeleton>
                    <div className="h-4 w-5/6 rounded mb-2 bg-transparent"></div>
                    <div className="h-4 w-4/6 rounded bg-transparent"></div>
                  </ChatBubble>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background p-4">
        <div className="max-w-3xl mx-auto">
          {/* Selected attachments (chips) */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-accent/30 px-2 py-1 text-xs text-foreground"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="font-medium">{a.name}</span>
                  <span className="text-muted-foreground">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  {a.error && <span className="text-warning">- {a.error}</span>}
                  <button
                    aria-label={`Remove ${a.name}`}
                    className="ml-1 rounded hover:bg-muted p-0.5"
                    onClick={() => removeAttachment(a.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex space-x-3">
            <div className="flex-1">
              <Textarea
                ref={textareaRef}
                placeholder="Describe your symptoms..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                className="min-h-[60px] max-h-[200px] resize-none border-border"
                disabled={isLoading}
              />
            </div>
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept=".txt,.md,.csv,.json,text/*,application/json"
                onChange={handleFilesSelected}
              />
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={triggerFilePicker}
                disabled={isLoading}
                title="Attach files"
                className="px-3"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            <Button
              onClick={sendMessage}
              disabled={!input.trim() || isLoading || pendingUploads > 0}
              size="lg"
              className="px-6"
            >
              <Send className="h-4 w-4" />
            </Button>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-2 text-center">
            Press Enter to send, Shift+Enter for new line
            {pendingUploads > 0 && (
              <span className="ml-2 text-warning">Uploading files...</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SymptomChat;
