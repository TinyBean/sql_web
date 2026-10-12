import type { Config as DomPurifyConfig } from "dompurify";
import { parseMarkdown } from "./markdown-parser.ts";

type MarkedModule = typeof import("marked");

interface MarkdownGlobals {
  readonly DOMPurify?: {
    sanitize(dirty: string, config?: DomPurifyConfig): string;
  };
  readonly marked?: MarkedModule;
}

const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "embed",
    "form",
    "iframe",
    "img",
    "object",
    "picture",
    "script",
    "source",
    "style",
    "template",
  ],
  FORBID_ATTR: ["srcset", "style"],
  ALLOW_DATA_ATTR: false,
} satisfies DomPurifyConfig;

function markdownGlobals(): MarkdownGlobals {
  return globalThis as typeof globalThis & MarkdownGlobals;
}

export function renderMarkdownInto(
  element: HTMLElement,
  source: string,
): void {
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
    const parsed = parseMarkdown(marked, source);
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = String(DOMPurify.sanitize(parsed, SANITIZE_OPTIONS));
    for (const link of template.content.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    element.replaceChildren(template.content);
  } catch {
    element.textContent = source;
  }
}
