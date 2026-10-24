import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../utils';

type Props = {
  content: string;
  className?: string;
  /** Pass true while the message is still streaming */
  streaming?: boolean;
};

// ---------------------------------------------------------------------------
// Text normalisation — runs on every render tick during streaming
// ---------------------------------------------------------------------------

function normalizeLLMText(raw: string): string {
  if (!raw) return raw;
  let s = raw;

  // 1. Strip complete <thought>…</thought> blocks (Gemma 4 chain-of-thought)
  s = s.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

  // 2. Strip a partial <thought> that hasn't closed yet (mid-stream).
  //    We only strip if there is no closing tag so we don't eat real content.
  s = s.replace(/<thought>[\s\S]*$/, (match) =>
    match.includes('</thought>') ? match : ''
  );

  // 3. Common LLM HTML artefacts → Markdown
  s = s.replace(/<br\s*\/?>(\s*)/gi, '\n$1');
  s = s.replace(/^\s*[•·]\s+/gm, '- ');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/** True while Gemma is generating its internal <thought> block and no visible content exists yet */
function isInsideThoughtBlock(raw: string, visible: string): boolean {
  if (visible !== '') return false;
  return /<thought>/i.test(raw) && !/<\/thought>/i.test(raw);
}

// ---------------------------------------------------------------------------
// Dot animation shown during the thinking phase
// ---------------------------------------------------------------------------
function ThinkingPill() {
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/60 border border-border/50 text-xs text-muted-foreground select-none">
      <span className="flex items-center gap-1">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50"
            style={{ animation: `mdBounce 1.2s ease-in-out ${i * 0.18}s infinite` }}
          />
        ))}
      </span>
      Thinking…
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const Markdown: React.FC<Props> = ({ content, className, streaming }) => {
  const normalized = normalizeLLMText(content);
  const thinking = streaming && isInsideThoughtBlock(content, normalized);

  return (
    <div className={cn('md-prose', className)}>
      {thinking ? (
        <ThinkingPill />
      ) : (
        <>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              /* ── Block elements ── */
              h1: ({ children, ...p }) => (
                <h1 className="text-[1.15rem] font-bold mt-5 mb-2 leading-snug tracking-tight" {...p}>{children}</h1>
              ),
              h2: ({ children, ...p }) => (
                <h2 className="text-[1.05rem] font-semibold mt-4 mb-2 leading-snug" {...p}>{children}</h2>
              ),
              h3: ({ children, ...p }) => (
                <h3 className="text-sm font-semibold mt-3 mb-1.5 leading-snug" {...p}>{children}</h3>
              ),
              h4: ({ children, ...p }) => (
                <h4 className="text-sm font-medium mt-2 mb-1" {...p}>{children}</h4>
              ),

              p: ({ children, ...p }) => (
                <p className="mb-2.5 last:mb-0 leading-[1.7]" {...p}>{children}</p>
              ),

              ul: ({ children, ...p }) => (
                <ul className="mb-2.5 pl-5 list-disc space-y-1 marker:text-muted-foreground/60" {...p}>{children}</ul>
              ),
              ol: ({ children, ...p }) => (
                <ol className="mb-2.5 pl-5 list-decimal space-y-1 marker:text-muted-foreground/60" {...p}>{children}</ol>
              ),
              li: ({ children, ...p }) => (
                <li className="leading-[1.65] pl-0.5" {...p}>{children}</li>
              ),

              blockquote: ({ children, ...p }) => (
                <blockquote
                  className="my-3 border-l-[3px] border-primary/40 pl-4 pr-2 py-0.5 text-muted-foreground italic bg-muted/20 rounded-r-md"
                  {...p}
                >
                  {children}
                </blockquote>
              ),

              hr: (p) => <hr className="my-4 border-border/50" {...p} />,

              /* ── Inline ── */
              strong: ({ children, ...p }) => (
                <strong className="font-semibold" {...p}>{children}</strong>
              ),
              em: ({ children, ...p }) => (
                <em className="italic opacity-90" {...p}>{children}</em>
              ),
              del: ({ children, ...p }) => (
                <del className="line-through opacity-60" {...p}>{children}</del>
              ),

              /* ── Code ── */
              code: ({ className: cls, children, ...p }) => {
                const isBlock = Boolean(cls) || String(children).includes('\n');
                if (!isBlock) {
                  return (
                    <code
                      className="px-1.5 py-0.5 rounded-md text-[0.82em] font-mono
                                 bg-rose-50 text-rose-700 border border-rose-200/60
                                 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/40"
                      {...p}
                    >
                      {children}
                    </code>
                  );
                }
                const lang = cls?.replace('language-', '') ?? '';
                return (
                  <div className="my-3 rounded-xl overflow-hidden border border-border/60 shadow-sm">
                    {lang && (
                      <div className="flex items-center px-4 py-1.5 bg-muted/70 border-b border-border/50">
                        <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest">
                          {lang}
                        </span>
                      </div>
                    )}
                    <pre className="bg-[#1e1e2e] dark:bg-[#13131f] p-4 overflow-x-auto text-[#cdd6f4]">
                      <code className={cn('font-mono text-[0.82rem] leading-relaxed', cls)} {...p}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              },

              /* ── Tables ── */
              table: ({ children, ...p }) => (
                <div className="overflow-x-auto my-3 rounded-xl border border-border shadow-sm">
                  <table className="w-full border-collapse text-sm" {...p}>{children}</table>
                </div>
              ),
              thead: ({ children, ...p }) => (
                <thead className="bg-muted/70 border-b border-border" {...p}>{children}</thead>
              ),
              th: ({ children, ...p }) => (
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground" {...p}>
                  {children}
                </th>
              ),
              td: ({ children, ...p }) => (
                <td className="px-3 py-2 border-b border-border/40 align-top" {...p}>{children}</td>
              ),
              tr: ({ children, ...p }) => (
                <tr className="even:bg-muted/20 hover:bg-muted/40 transition-colors duration-100" {...p}>
                  {children}
                </tr>
              ),
              tbody: ({ children, ...p }) => <tbody {...p}>{children}</tbody>,

              /* ── Links ── */
              a: ({ href, children, ...p }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-600 dark:text-sky-400 underline underline-offset-2 decoration-sky-400/50 hover:decoration-sky-400 transition-colors"
                  {...p}
                >
                  {children}
                </a>
              ),
            }}
          >
            {normalized}
          </ReactMarkdown>

          {/* Blinking cursor while streaming */}
          {streaming && normalized && (
            <span
              aria-hidden="true"
              className="inline-block w-[2px] h-[1em] bg-current align-[-0.15em] ml-0.5
                         animate-[mdBlink_0.9s_step-end_infinite]"
            />
          )}
        </>
      )}
    </div>
  );
};

export default Markdown;
