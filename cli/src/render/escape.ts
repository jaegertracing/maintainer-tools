const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}
