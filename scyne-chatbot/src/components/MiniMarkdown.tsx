function inline(text: string): React.ReactNode[] {
  // Token order: code spans → links → bold → plain
  const out: any[] = [];
  let buf = text;

  // Step 1: split on `code spans` first
  const codeRe = /`([^`]+)`/g;
  let last = 0;
  const codeMatches = [...buf.matchAll(codeRe)];
  if (codeMatches.length === 0) {
    return inlineBoldAndLinks(buf);
  }
  for (const m of codeMatches) {
    if (m.index! > last) out.push(...inlineBoldAndLinks(buf.slice(last, m.index)));
    out.push(<code key={`c-${m.index}`} className="font-mono text-[12.5px] bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded">{m[1]}</code>);
    last = m.index! + m[0].length;
  }
  if (last < buf.length) out.push(...inlineBoldAndLinks(buf.slice(last)));
  return out;
}

function inlineBoldAndLinks(text: string): React.ReactNode[] {
  const out: any[] = [];
  // [label](url) first
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m;
  const linkMatches = [...text.matchAll(linkRe)];
  if (linkMatches.length) {
    for (const lm of linkMatches) {
      if (lm.index! > last) out.push(...inlineBoldAndAutolink(text.slice(last, lm.index)));
      out.push(
        <a key={`l-${lm.index}`} href={lm[2]} target="_blank" rel="noreferrer" className="text-scyne-ink underline break-all">
          {lm[1]}
        </a>
      );
      last = lm.index! + lm[0].length;
    }
    if (last < text.length) out.push(...inlineBoldAndAutolink(text.slice(last)));
    return out;
  }
  return inlineBoldAndAutolink(text);
}

function inlineBoldAndAutolink(text: string): React.ReactNode[] {
  // bold first
  const out: any[] = [];
  const boldRe = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(boldRe)) {
    if (m.index! > last) out.push(...autolink(text.slice(last, m.index)));
    out.push(<strong key={`b-${m.index}`}>{m[1]}</strong>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...autolink(text.slice(last)));
  return out;
}

function autolink(text: string): React.ReactNode[] {
  // bare URLs
  const out: any[] = [];
  const urlRe = /(https?:\/\/[^\s)>\]"'`]+)/g;
  let last = 0;
  for (const m of text.matchAll(urlRe)) {
    if (m.index! > last) out.push(<span key={`t-${m.index}`}>{text.slice(last, m.index)}</span>);
    out.push(<a key={`u-${m.index}`} href={m[0]} target="_blank" rel="noreferrer" className="text-scyne-ink underline break-all">{m[0]}</a>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(<span key={`r${last}`}>{text.slice(last)}</span>);
  return out;
}

export function MiniMarkdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const out: any[] = [];
  let listBuf: string[] = [];
  let codeBuf: string[] = [];
  let inCode = false;

  const flushList = () => {
    if (listBuf.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc pl-5 space-y-0.5 my-2">
          {listBuf.map((li, k) => <li key={k}>{inline(li)}</li>)}
        </ul>
      );
      listBuf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trimEnd();

    if (l.startsWith("```")) {
      if (inCode) {
        out.push(
          <pre key={`pre-${i}`} className="my-2 p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre">
            {codeBuf.join("\n")}
          </pre>
        );
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    if (l.startsWith("# ")) { flushList(); out.push(<h2 key={i} className="text-lg font-bold mt-3 mb-1">{inline(l.slice(2))}</h2>); }
    else if (l.startsWith("## ")) { flushList(); out.push(<h3 key={i} className="text-base font-semibold mt-3 mb-1">{inline(l.slice(3))}</h3>); }
    else if (l.startsWith("### ")) { flushList(); out.push(<h4 key={i} className="text-sm font-semibold mt-2 mb-1">{inline(l.slice(4))}</h4>); }
    else if (l.startsWith("- ") || l.startsWith("* ")) { listBuf.push(l.slice(2)); }
    else if (l === "") { flushList(); out.push(<div key={i} className="h-1.5" />); }
    else { flushList(); out.push(<p key={i} className="text-[14px] leading-relaxed">{inline(l)}</p>); }
  }
  flushList();
  if (codeBuf.length) {
    out.push(<pre key="pre-tail" className="my-2 p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre">{codeBuf.join("\n")}</pre>);
  }
  return <div>{out}</div>;
}
