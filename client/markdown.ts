import type { Config as DomPurifyConfig } from "dompurify";
import type { Marked } from "marked";

interface MarkdownGlobals {
  readonly DOMPurify?: {
    sanitize(dirty: string, config?: DomPurifyConfig): string;
  };
  readonly marked?: Marked;
}

const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["embed", "form", "iframe", "object", "script", "style", "template"],
  FORBID_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
} satisfies DomPurifyConfig;

function markdownGlobals(): MarkdownGlobals {
  return globalThis as typeof globalThis & MarkdownGlobals;
}

/** Render model-authored Markdown without trusting its generated HTML. */
export function renderMarkdownInto(element: HTMLElement, source: string): void {
  if (!source) {
    element.replaceChildren();
    return;
  }

  const { marked, DOMPurify } = markdownGlobals();
  if (!marked || !DOMPurify) {
    element.textContent = source;
    return;
  }

  try {
    const unsafeHtml = marked.parse(source, {
      async: false,
      breaks: true,
      gfm: true,
    });
    element.innerHTML = String(DOMPurify.sanitize(unsafeHtml, SANITIZE_OPTIONS));
    for (const link of element.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  } catch {
    element.textContent = source;
  }
}
