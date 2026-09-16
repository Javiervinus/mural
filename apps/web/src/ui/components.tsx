import { useEffect, useState, type ReactNode } from "react";
import { loadMandarin, mandarinReading, mandarinReady } from "../core/captions";
import { openExternal } from "../services/platform";
import { Icon } from "./icons";
import type { SourceLink } from "../core/models";
import { safeURL } from "../core/models";

export function Brand() {
  return (
    <span className="brand" aria-label="Mural">
      <span className="brand__dot" />
      mural
    </span>
  );
}

export function PageHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <header>
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="heading">{title}</h1>
      {subtitle ? <p className="subtitle">{subtitle}</p> : null}
    </header>
  );
}

export function RecallBars({ count }: { count: number }) {
  return (
    <div className="bars" role="img" aria-label={`${count} of 3 recall bars`}>
      {[0, 1, 2].map((i) => <span key={i} className={i < count ? "on" : ""} />)}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={className} onClick={(event) => { event.preventDefault(); void openExternal(href); }} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Sources({ sources, date }: { sources: SourceLink[]; date: Date }) {
  const valid = sources.filter((s) => safeURL(s));
  if (!valid.length) return null;
  return (
    <div className="sources">
      <div className="caption">Sources · {date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</div>
      {valid.map((source) => (
        <ExternalLink key={source.url} href={source.url}><Icon name="arrow.up.right" />{source.title}</ExternalLink>
      ))}
    </div>
  );
}

/** Keeps Han text selectable and word links intact, with an optional reading below it. */
export function PinyinHelp({ text, align = "center" }: { text: string; align?: "center" | "left" }) {
  const [expanded, setExpanded] = useState(true);
  const [, setReady] = useState(mandarinReady());
  useEffect(() => { if (!mandarinReady()) void loadMandarin().then(() => setReady(true)); }, []);
  const reading = mandarinReading(text);
  if (!reading) return null;
  return (
    <div className={`pinyin${align === "left" ? " pinyin--left" : ""}`}>
      <button className="button-text" onClick={() => setExpanded((v) => !v)}>
        <Icon name={expanded ? "chevron.up" : "chevron.down"} />{expanded ? "Hide pinyin" : "Show pinyin"}
      </button>
      {expanded ? <div className="pinyin__reading">{reading}</div> : null}
    </div>
  );
}

export interface SheetProps {
  open: boolean;
  title?: string;
  onClose: () => void;
  size?: "medium" | "large";
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  dismissible?: boolean;
}

export function Sheet({ open, title, onClose, size = "medium", leading, trailing, children, dismissible = true }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && dismissible) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && dismissible) onClose(); }}>
      <div className={`sheet${size === "large" ? " sheet--large" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grabber" />
        {(title || leading || trailing) ? (
          <div className="sheet__header">
            <div className="sheet__action">{leading}</div>
            <h2>{title}</h2>
            <div className="sheet__action sheet__action--right">{trailing}</div>
          </div>
        ) : null}
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}

export function Alert({ title, message, actions }: { title: string; message?: string; actions: Array<{ label: string; onClick: () => void; kind?: "primary" | "danger" | "plain" }> }) {
  return (
    <div className="alert-backdrop" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="alert">
        <h3>{title}</h3>
        {message ? <p>{message}</p> : null}
        <div className="alert__actions">
          {actions.map((action) => (
            <button key={action.label} className={action.kind ?? "plain"} onClick={action.onClick}>{action.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

/** Minimal markdown: paragraphs, **bold**, *italic* and [links](https://…). Everything else is plain text. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`markdown ${className ?? ""}`.trim()}>
      {paragraphs.map((paragraph, index) => <p key={index}>{renderInline(paragraph)}</p>)}
    </div>
  );
}

const INLINE = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    if (match[1]) {
      const href = match[3]!;
      nodes.push(href.startsWith("https://") ? <ExternalLink key={key++} href={href}>{match[2]}</ExternalLink> : match[2]);
    } else if (match[4]) nodes.push(<strong key={key++}>{match[5]}</strong>);
    else if (match[6]) nodes.push(<em key={key++}>{match[7]}</em>);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function formatDate(date: Date, time = false): string {
  return date.toLocaleString(undefined, time ? { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}
