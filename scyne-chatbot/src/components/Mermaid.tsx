import { useEffect, useRef, useState } from "react";

// Mermaid is ~2 MB. It is imported dynamically so it lands in its own chunk and
// only downloads when a document that actually contains a diagram is opened —
// most approval previews (stories, gaps) have none.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        // Our own agents author these diagrams on localhost, but strict still
        // costs nothing and blocks script/HTML injection through node labels.
        securityLevel: "strict",
        theme: "base",
        fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
        themeVariables: {
          primaryColor: "#eef0f7",
          primaryTextColor: "#1f2340",
          primaryBorderColor: "#464e7e",
          lineColor: "#7c86ad",
          secondaryColor: "#f6f2ee",
          tertiaryColor: "#ffffff",
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let seq = 0;

/**
 * One Mermaid diagram. Renders only once it scrolls into view: a data model has
 * 4 diagrams and a persona set has 12, and rendering them all the moment a tab
 * opens locks the pane for seconds when the reader can see one at a time.
 */
export function Mermaid({ chart }: { chart: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || visible) return;
    // rootMargin so a diagram starts rendering just before it is scrolled to.
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true); },
      { root: null, rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setFailed(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(`mmd-${(seq += 1)}`, chart))
      .then(({ svg }) => { if (!cancelled) setSvg(svg); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [visible, chart]);

  // A diagram that will not parse is still information — show its source rather
  // than an empty box, so the reviewer can see what the agent intended.
  if (failed) {
    return (
      <div className="my-3">
        <div className="text-[11px] font-medium text-amber-700 mb-1">
          Diagram could not be rendered — showing source
        </div>
        <pre className="overflow-x-auto rounded-md border border-scyne-line bg-slate-50 p-3 text-[11.5px] font-mono text-slate-700">
          {chart}
        </pre>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="my-3 overflow-x-auto rounded-md border border-scyne-line bg-white p-3">
      {svg ? (
        <div className="[&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="h-16 animate-pulse rounded bg-slate-100" />
      )}
    </div>
  );
}
