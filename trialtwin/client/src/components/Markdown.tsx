import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Props = {
  content: string;
  className?: string;
};

// Normalize common LLM HTML-ish output into Markdown-friendly text
function normalizeLLMText(input: string): string {
  if (!input) return input;
  let s = input;
  // Convert <br>, <br/>, <br /> to newlines
  s = s.replace(/<br\s*\/?>(\s*)/gi, "\n$1");
  // Convert bullet characters at line starts to markdown list items
  s = s.replace(/^\s*[•·]\s+/gm, "- ");
  // De-duplicate excessive blank lines that can appear after conversions
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

// Safe Markdown renderer (no raw HTML). Supports GFM (tables, task lists, strikethrough).
const Markdown: React.FC<Props> = ({ content, className }) => {
  const normalized = normalizeLLMText(content);
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Do not enable raw HTML parsing to avoid XSS
        components={{
          a: ({ node, href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-foreground"
              {...props}
            >
              {children}
            </a>
          ),
          code: ({ node, inline, className, children, ...props }) => {
            if (inline) {
              return (
                <code
                  className={`px-1 py-0.5 rounded bg-muted font-mono text-sm ${className || ''}`}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <pre className="bg-muted border border-border rounded-lg p-4 overflow-x-auto">
                <code className={`font-mono text-sm ${className || ''}`} {...props}>
                  {children}
                </code>
              </pre>
            );
          },
          blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-2 border-border pl-4 text-muted-foreground" {...props}>
              {children}
            </blockquote>
          ),
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" {...props}>{children}</table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th className="border border-border px-2 py-1 text-left bg-muted" {...props}>{children}</th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-border px-2 py-1 align-top" {...props}>{children}</td>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
};

export default Markdown;
