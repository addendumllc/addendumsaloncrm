import { Children, Fragment, isValidElement, type ReactNode } from 'react';

// Short words stay lower case inside a heading (not first or last, or after a colon/dash).
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with']);

/**
 * Title Case for headings: “Today’s priorities and follow-ups” → “Today’s Priorities and Follow-Ups”. Words that already
 * carry their own capitals or aren’t plain words (SKU, HighLevel, iPhone, emails, #60, 22") are left exactly as they are.
 */
export function titleCase(s: string): string {
  const parts = s.split(/(\s+)/);
  const words = parts.map((p, i) => ({ p, i })).filter(({ p }) => p.trim());
  let afterBreak = true;
  return parts.map((p, i) => {
    if (!p.trim()) return p;
    const n = words.findIndex((w) => w.i === i);
    const edge = afterBreak || n === words.length - 1;
    afterBreak = /[:—–]$/.test(p) || /^[—–]$/.test(p);
    return p.split('-').map((seg, k) => fixWord(seg, edge || k > 0)).join('-');
  }).join('');
}

function fixWord(w: string, edge: boolean) {
  const m = /^([^A-Za-z]*)([A-Za-z][A-Za-z'’]*)(.*)$/.exec(w);
  if (!m) return w;
  const [, lead, core, tail] = m;
  if (/[@/\\.]\w/.test(w) || /\d/.test(core) || /[A-Z]/.test(core.slice(1))) return w; // emails, paths, SKUs, iPhone
  if (lead && /[#\d]/.test(lead)) return w;
  const lower = core.toLowerCase();
  if (!edge && SMALL.has(lower)) return lead + lower + tail;
  return lead + core[0].toUpperCase() + core.slice(1) + tail;
}

/** Applies Title Case to the plain text in a heading; icons, badges and other elements are left alone. */
export function tc(node: ReactNode): ReactNode {
  if (typeof node === 'string') return titleCase(node);
  if (Array.isArray(node)) return Children.map(node, tc);
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return <>{tc(node.props.children)}</>;
  return node;
}

/** <Tc>…</Tc> inside a heading element. */
export function Tc({ children }: { children?: ReactNode }) {
  return <>{tc(children)}</>;
}
