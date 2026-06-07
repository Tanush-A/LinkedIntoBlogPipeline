// src/lib/markdown.ts
// Minimal, XSS-safe markdown → HTML for the review page. Drafts are LLM-generated from
// scraped text — untrusted — so we ESCAPE THE WHOLE STRING FIRST (including quotes, for
// attribute safety), then apply a small block/inline subset: headings, bold, italic, inline
// code, http(s) links, unordered lists, hr, paragraphs. Not a general markdown engine.

/** Escape for both text and attribute contexts (quotes included — see link href below). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  let t = text;
  // inline code first (so * and [] inside code are not treated as markdown)
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // links [label](http(s)://...) — only http(s); the url was quote-escaped above, so any
  // injected quote is already &quot; and sits inertly inside the href attribute.
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  // bold then italic
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return t;
}

export function renderMarkdown(md: string): string {
  const escaped = escapeHtml(md.trim());
  const blocks = escaped.split(/\n{2,}/);
  const html: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const first = lines[0].trim();

    if (/^###\s+/.test(first)) { html.push(`<h3>${inline(first.replace(/^###\s+/, ''))}</h3>`); continue; }
    if (/^##\s+/.test(first))  { html.push(`<h2>${inline(first.replace(/^##\s+/, ''))}</h2>`); continue; }
    if (/^#\s+/.test(first))   { html.push(`<h1>${inline(first.replace(/^#\s+/, ''))}</h1>`); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(first)) { html.push('<hr />'); continue; }

    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('');
      html.push(`<ul>${items}</ul>`);
      continue;
    }

    // paragraph — join wrapped lines with a space
    html.push(`<p>${inline(lines.map((l) => l.trim()).join(' '))}</p>`);
  }

  return html.join('\n');
}
