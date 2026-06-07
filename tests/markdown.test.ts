// tests/markdown.test.ts
// The review-page markdown renderer. Drafts are LLM-generated from scraped text (untrusted),
// so XSS safety is the load-bearing property here.

import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml } from '../src/lib/markdown';

describe('renderMarkdown — formatting', () => {
  it('renders headings, bold, italic, lists, and http links', () => {
    const html = renderMarkdown(
      [
        '## Why Your Best Rep Can’t Tell You',
        '',
        'This is **bold** and this is *italic*.',
        '',
        '- one',
        '- two',
        '',
        'See [the post](https://example.com/x).',
      ].join('\n'),
    );
    expect(html).toContain('<h2>Why Your Best Rep');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">the post</a>');
  });

  it('wraps prose in <p> and renders --- as <hr />', () => {
    const html = renderMarkdown('First para.\n\n---\n\nSecond para.');
    expect(html).toContain('<p>First para.</p>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Second para.</p>');
  });
});

describe('renderMarkdown — XSS safety', () => {
  it('escapes a quote-breakout link payload (no live attribute injected)', () => {
    // A " inside the link URL must not close the href and inject an event handler.
    const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1)');
    expect(html).toContain('&quot;');            // the quote was escaped
    expect(html).not.toContain('"onmouseover="'); // ...so it never breaks out of href
    expect(html).not.toContain('onmouseover="alert');
  });

  it('neutralizes raw HTML / script tags in any block', () => {
    const html = renderMarkdown('## <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapeHtml covers both text and attribute contexts', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});
