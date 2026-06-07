// src/lib/text.ts
// Pure text helpers shared across the pipeline with no DB or network dependency.
// splitTitleAndBody lives here (not publish.ts) so db.ts (getPublishedRefs) and
// publish.ts can both import it without a circular module dependency.

/**
 * The revise pass emits "TITLE: <title>\n\n<body>" as its output contract.
 * Extract both; fall back to a legacy first-line scan if the TITLE: line is absent.
 */
export function splitTitleAndBody(revised_draft: string): { title: string; body: string } {
  const lines = revised_draft.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  if (firstLine.startsWith('TITLE:')) {
    const title = firstLine.replace(/^TITLE:\s*/, '').trim().slice(0, 60);
    // Skip the TITLE line and any immediately following blank lines
    const rest = lines.slice(1);
    const bodyStart = rest.findIndex((l) => l.trim() !== '');
    const body = rest.slice(bodyStart >= 0 ? bodyStart : 0).join('\n').trim();
    return { title, body };
  }
  // Fallback for drafts written before the Stage 4 revise contract
  return { title: deriveTitle(revised_draft), body: revised_draft };
}

export function deriveTitle(draft_text: string): string {
  const firstLine = draft_text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return (firstLine ?? `Draft`).slice(0, 60);
}

/** First non-empty line of a post, stripped and truncated — used for theme/summary labels. */
export function firstLine(text: string, max = 60): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, max);
}
