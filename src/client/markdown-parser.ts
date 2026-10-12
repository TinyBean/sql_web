type MarkedModule = typeof import("marked");

function escapeHtml(source: string): string {
  return source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Parse Markdown while keeping every image reference out of the HTML resource graph. */
export function parseMarkdown(
  marked: MarkedModule,
  source: string,
): string {
  const parser = new marked.Marked({
    tokenizer: {
      del(source) {
        // Marked's GFM tokenizer also accepts ~text~. Keep single tildes as
        // ordinary text so multiple ranges cannot accidentally span a <del>.
        return source.startsWith("~~") ? false : undefined;
      },
    },
    renderer: {
      image(token) {
        return escapeHtml(token.text);
      },
      html(token) {
        return escapeHtml(token.text);
      },
    },
  });
  return parser.parse(source, {
    async: false,
    breaks: true,
    gfm: true,
  });
}
