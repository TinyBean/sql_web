import type { Config as DomPurifyConfig } from "dompurify";
import type { ChatImage } from "../shared/contracts.ts";
import { stripGeneratedImageMarkdown } from "../shared/image-references.ts";
import { resolveGeneratedImageLayout } from "./image-placeholders.ts";
import {
  MARKDOWN_IMAGE_PLACEHOLDER_CLASS,
  MARKDOWN_IMAGE_PLACEHOLDER_ID_PREFIX,
  parseMarkdownWithImagePlaceholders,
  type MarkdownImageReference,
} from "./markdown-parser.ts";

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

const GENERATED_IMAGE_ID_ATTRIBUTE = "data-generated-image-id";

export interface MarkdownRenderOptions {
  /** Shared by Markdown containers in one claim scope, such as thought fragments. */
  readonly claimedGeneratedImageIds?: Set<string>;
}

function markdownGlobals(): MarkdownGlobals {
  return globalThis as typeof globalThis & MarkdownGlobals;
}

function placeholderReference(
  node: Element,
  references: readonly MarkdownImageReference[],
): MarkdownImageReference | null {
  const id = node.getAttribute("id") ?? "";
  if (!id.startsWith(MARKDOWN_IMAGE_PLACEHOLDER_ID_PREFIX)) return null;
  const rawIndex = id.slice(MARKDOWN_IMAGE_PLACEHOLDER_ID_PREFIX.length);
  if (!/^(?:0|[1-9]\d*)$/u.test(rawIndex)) return null;
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) ? references[index] ?? null : null;
}

function safeMarkdownImageSource(source: string): boolean {
  const normalized = source.trim();
  if (!normalized || /[\u0000-\u001F\u007F]/u.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/u.test(lower)) return true;
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(normalized)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "blob" || scheme === "http" || scheme === "https";
}

function markdownImage(
  node: Element,
  reference: MarkdownImageReference,
): HTMLImageElement {
  const image = node.ownerDocument.createElement("img");
  image.src = reference.source;
  image.alt = reference.alt;
  if (reference.title) image.title = reference.title;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function generatedImageSource(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function reusableGeneratedImages(
  element: HTMLElement,
): ReadonlyMap<string, HTMLImageElement> {
  const reusable = new Map<string, HTMLImageElement>();
  for (const image of element.querySelectorAll<HTMLImageElement>(
    `img.code-interpreter-image[${GENERATED_IMAGE_ID_ATTRIBUTE}]`,
  )) {
    const id = image.getAttribute(GENERATED_IMAGE_ID_ATTRIBUTE) ?? "";
    if (id && !reusable.has(id)) reusable.set(id, image);
  }
  return reusable;
}

function hydratedImage(
  node: Element,
  image: ChatImage,
  reference: MarkdownImageReference,
  reusable: ReadonlyMap<string, HTMLImageElement>,
): HTMLImageElement {
  const source = generatedImageSource(image);
  const existing = reusable.get(image.id);
  const canReuse = existing?.getAttribute("src") === source;
  const hydrated = canReuse ? existing : node.ownerDocument.createElement("img");
  if (!canReuse) hydrated.src = source;
  hydrated.alt = reference.alt || image.alt;
  hydrated.loading = "lazy";
  hydrated.decoding = "async";
  hydrated.classList.add("code-interpreter-image");
  hydrated.setAttribute(GENERATED_IMAGE_ID_ATTRIBUTE, image.id);
  return hydrated;
}

function hydrateGeneratedImages(
  root: ParentNode,
  references: readonly MarkdownImageReference[],
  images: readonly ChatImage[],
  reusable: ReadonlyMap<string, HTMLImageElement>,
  claimedGeneratedImageIds: Set<string>,
): void {
  const nodes = [...root.querySelectorAll(`span.${MARKDOWN_IMAGE_PLACEHOLDER_CLASS}`)];
  const nodeReferences = nodes.map((node) => placeholderReference(node, references));
  const layout = resolveGeneratedImageLayout(
    nodeReferences.map((reference) => reference?.source ?? null),
    images,
    claimedGeneratedImageIds,
  );
  for (const [index, node] of nodes.entries()) {
    const resolution = layout.resolutions[index];
    const reference = nodeReferences[index];
    if (!resolution || !reference || resolution.kind === "remove") {
      node.remove();
      continue;
    }
    if (resolution.kind === "preserve") {
      if (safeMarkdownImageSource(reference.source)) {
        node.replaceWith(markdownImage(node, reference));
      } else {
        node.remove();
      }
      continue;
    }
    node.replaceWith(hydratedImage(node, resolution.image, reference, reusable));
  }
}

/**
 * Render model-authored Markdown without trusting its generated HTML, then
 * replace only stable generated-image references with persisted images.
 * Unreferenced generated images are intentionally not rendered.
 */
export function renderMarkdownInto(
  element: HTMLElement,
  source: string,
  images: readonly ChatImage[] = [],
  options: MarkdownRenderOptions = {},
): void {
  if (!source) {
    element.replaceChildren();
    return;
  }

  const { marked, DOMPurify } = markdownGlobals();
  if (!marked || !DOMPurify) {
    element.textContent = stripGeneratedImageMarkdown(source);
    return;
  }

  try {
    const reusable = reusableGeneratedImages(element);
    const parsed = parseMarkdownWithImagePlaceholders(marked, source);
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = String(DOMPurify.sanitize(parsed.html, SANITIZE_OPTIONS));
    hydrateGeneratedImages(
      template.content,
      parsed.imageReferences,
      images,
      reusable,
      options.claimedGeneratedImageIds ?? new Set<string>(),
    );
    for (const link of template.content.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    element.replaceChildren(template.content);
  } catch {
    element.textContent = stripGeneratedImageMarkdown(source);
  }
}
