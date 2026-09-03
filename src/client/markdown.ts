import type { Config as DomPurifyConfig } from "dompurify";
import type { Marked } from "marked";
import type { ChatImage } from "../shared/contracts.ts";
import { isRuntimeImagePlaceholder } from "./image-placeholders.ts";

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

function hydrateGeneratedImages(
  element: HTMLElement,
  images: readonly ChatImage[],
): number {
  let imageIndex = 0;
  for (const node of element.querySelectorAll("img")) {
    if (!isRuntimeImagePlaceholder(node.getAttribute("src"))) continue;
    const generated = images[imageIndex];
    if (!generated) {
      if (images.length) node.remove();
      continue;
    }
    node.src = `data:${generated.mimeType};base64,${generated.data}`;
    if (!node.alt) node.alt = generated.alt;
    node.loading = "lazy";
    node.decoding = "async";
    node.classList.add("code-interpreter-image");
    imageIndex += 1;
  }
  return imageIndex;
}

/**
 * Render model-authored Markdown without trusting its generated HTML, then
 * replace runtime-only image placeholders with persisted interpreter images.
 * The return value is the number of images embedded into the Markdown body.
 */
export function renderMarkdownInto(
  element: HTMLElement,
  source: string,
  images: readonly ChatImage[] = [],
): number {
  if (!source) {
    element.replaceChildren();
    return 0;
  }

  const { marked, DOMPurify } = markdownGlobals();
  if (!marked || !DOMPurify) {
    element.textContent = source;
    return 0;
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
    return hydrateGeneratedImages(element, images);
  } catch {
    element.textContent = source;
    return 0;
  }
}
