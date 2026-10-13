/**
 * Fills {placeholders} in an owner-written template. Empty placeholders are left out cleanly: a short
 * connecting word in front of them goes too ("with {stylist}" → ""), so texts never read "with :".
 */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>) {
  const val = (k: string) => (vars[k] ?? '').toString().trim();
  return template
    .replace(/[ \t]+(?:with|for|on|at|by|from)[ \t]+\{(\w+)\}/gi, (m, k: string) => (val(k) ? m : ''))
    .replace(/\{(\w+)\}/g, (_m, k: string) => val(k))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?:;])/g, '$1')
    .replace(/([.,!?:;])\1+/g, '$1')
    .trim();
}
