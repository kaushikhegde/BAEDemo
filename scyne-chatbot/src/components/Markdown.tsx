import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mermaid } from "./Mermaid";
import { renderSource } from "@/lib/markdown";

/**
 * Full CommonMark + GFM renderer for the ARTEFACT documents.
 *
 * `MiniMarkdown` stays for chat bubbles and agent comments — it is cheap and
 * handles short prose. It cannot do GFM tables or diagrams, which is fine for a
 * comment and useless for a document: the data model carries 421 table rows and
 * the persona set 12 Mermaid diagrams, and a reviewer approving those was being
 * shown raw pipe-delimited text.
 *
 * Raw HTML is deliberately NOT enabled (no rehype-raw) — the documents are
 * markdown, and parsing embedded HTML would be an injection surface for no gain.
 */
export function Markdown({ source, preserveLineBreaks = false }: {
  source: string;
  /**
   * Keep the source's line structure instead of letting CommonMark join
   * consecutive lines into a paragraph.
   *
   * OFF by default, and that default is load-bearing: this component renders
   * the artefacts behind the approval gate, which are proper markdown with
   * blank lines and real tables, and hard-breaking their soft-wrapped prose
   * would damage documents that read correctly today. Only the document
   * preview turns it on, and only for a file `convert-to-md.mjs` produced.
   */
  preserveLineBreaks?: boolean;
}) {
  const body = renderSource(source, preserveLineBreaks);
  return (
    <div className="text-[13.5px] leading-relaxed text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-5 mb-2 text-[17px] font-semibold text-slate-900 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2 border-b border-scyne-line pb-1 text-[15.5px] font-semibold text-slate-900 first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-1.5 text-[14px] font-semibold text-slate-800">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-3 mb-1 text-[13px] font-semibold uppercase tracking-wide text-slate-600">{children}</h4>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-scyne-ink underline underline-offset-2 hover:text-scyne-deep"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-scyne-ink/30 bg-slate-50 py-1 pl-3 text-slate-600">{children}</blockquote>
          ),
          hr: () => <hr className="my-4 border-scyne-line" />,
          strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,

          // Wide tables scroll inside their own container rather than forcing
          // the whole preview pane sideways.
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-scyne-line">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-scyne-line px-2.5 py-1.5 text-left font-semibold text-slate-800">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-scyne-line/60 px-2.5 py-1.5 align-top text-slate-700">{children}</td>
          ),

          // A ```mermaid fence becomes a diagram; every other fence stays a code
          // block. Handled on `pre` so the diagram is not nested inside one.
          pre: ({ children }) => {
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            if (/language-mermaid/.test(className)) {
              const chart = String(child?.props?.children ?? "").replace(/\n$/, "");
              return <Mermaid chart={chart} />;
            }
            return (
              <pre className="my-3 overflow-x-auto rounded-md border border-scyne-line bg-slate-50 p-3 text-[12px] font-mono text-slate-800">
                {children}
              </pre>
            );
          },
          code: ({ className, children }) =>
            className ? (
              // Inside our <pre> above — let the pre own the styling.
              <code className={className}>{children}</code>
            ) : (
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12.5px] text-slate-800">{children}</code>
            ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
