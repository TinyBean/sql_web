type MarkedModule = typeof import("marked");

export const MARKDOWN_IMAGE_PLACEHOLDER_CLASS = "markdown-image-reference";
export const MARKDOWN_IMAGE_PLACEHOLDER_ID_PREFIX = "markdown-image-reference-";

export interface MarkdownImageReference {
  readonly source: string;
  readonly alt: string;
  readonly title: string | null;
}

export interface ParsedMarkdownWithImagePlaceholders {
  readonly html: string;
  readonly imageReferences: readonly MarkdownImageReference[];
}

function escapeHtml(source: string): string {
  return source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Parse Markdown while keeping every image reference out of the HTML resource graph. */
export function parseMarkdownWithImagePlaceholders(
  marked: MarkedModule,
  source: string,
): ParsedMarkdownWithImagePlaceholders {
  const imageReferences: MarkdownImageReference[] = [];
  const parser = new marked.Marked({
    renderer: {
      image(token) {
        const index = imageReferences.push({
          source: token.href,
          alt: token.text,
          title: token.title,
        }) - 1;
        return `<span class="${MARKDOWN_IMAGE_PLACEHOLDER_CLASS}" id="${MARKDOWN_IMAGE_PLACEHOLDER_ID_PREFIX}${index}"></span>`;
      },
      html(token) {
        return escapeHtml(token.text);
      },
    },
  });
  return {
    html: parser.parse(source, {
      async: false,
      breaks: true,
      gfm: true,
    }),
    imageReferences,
  };
}
