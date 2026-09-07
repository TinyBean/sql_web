import type { ChatImage } from "../shared/contracts.ts";
import {
  GENERATED_IMAGE_PATH_PREFIX,
  isGeneratedImageReferenceSource,
  parseGeneratedImageReferenceSource,
} from "../shared/image-references.ts";

const GENERATED_IMAGE_ID_PREFIX = "ci%3A";

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isIndentedCode(source: string, index: number): boolean {
  const lineStart = Math.max(source.lastIndexOf("\n", index - 1), source.lastIndexOf("\r", index - 1)) + 1;
  return /^(?: {4,}|\t)/u.test(source.slice(lineStart, index));
}

function codeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  const fencedRanges: SourceRange[] = [];
  let openFence: { readonly character: "`" | "~"; readonly length: number; readonly start: number } | null = null;
  let offset = 0;

  for (const lineWithEnding of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.replace(/(?:\r\n|\r|\n)$/u, "");
    if (openFence) {
      const closing = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line)?.[1] ?? "";
      if (closing[0] === openFence.character && closing.length >= openFence.length) {
        fencedRanges.push({ start: openFence.start, end: offset + lineWithEnding.length });
        openFence = null;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1] ?? "";
      const character = opening[0];
      if (character === "`" || character === "~") {
        openFence = { character, length: opening.length, start: offset };
      }
    }
    offset += lineWithEnding.length;
  }
  if (openFence) fencedRanges.push({ start: openFence.start, end: source.length });
  ranges.push(...fencedRanges);

  const inFencedCode = (index: number): boolean => (
    fencedRanges.some((range) => index >= range.start && index < range.end)
  );
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] !== "`" || isEscaped(source, cursor) || inFencedCode(cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (source[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - cursor;
    let closingEnd = source.length;
    let search = runEnd;
    while (search < source.length) {
      if (source[search] !== "`" || isEscaped(source, search) || inFencedCode(search)) {
        search += 1;
        continue;
      }
      let candidateEnd = search + 1;
      while (source[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - search === runLength) {
        closingEnd = candidateEnd;
        break;
      }
      search = candidateEnd;
    }
    ranges.push({ start: cursor, end: closingEnd });
    cursor = closingEnd;
  }

  return ranges;
}

function possibleEncodedImageIdPrefix(source: string): boolean {
  if (source.length <= GENERATED_IMAGE_ID_PREFIX.length) {
    return GENERATED_IMAGE_ID_PREFIX.startsWith(source);
  }
  if (!source.startsWith(GENERATED_IMAGE_ID_PREFIX)) return false;

  for (let index = GENERATED_IMAGE_ID_PREFIX.length; index < source.length;) {
    const character = source[index] ?? "";
    if (/[A-Za-z0-9._~-]/u.test(character)) {
      index += 1;
      continue;
    }
    if (character !== "%") return false;
    const firstHex = source[index + 1];
    const secondHex = source[index + 2];
    if (firstHex === undefined) return true;
    if (!/[0-9A-F]/u.test(firstHex)) return false;
    if (secondHex === undefined) return true;
    if (!/[0-9A-F]/u.test(secondHex)) return false;
    index += 3;
  }
  return true;
}

function isIncompleteGeneratedImageMarkdown(source: string): boolean {
  let cursor = 2;
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (character === "\r" || character === "\n" || character === "[") return false;
    if (character === "\\") {
      const escaped = source[cursor + 1];
      if (escaped === undefined) return true;
      if (escaped !== "\\" && escaped !== "[" && escaped !== "]") return false;
      cursor += 2;
      continue;
    }
    if (character === "]") break;
    cursor += 1;
  }

  if (cursor === source.length) return true;
  cursor += 1;
  if (cursor === source.length) return true;
  if (source[cursor] !== "(") return false;
  cursor += 1;

  const destination = source.slice(cursor);
  if (destination.includes(")")) return false;
  if (destination.length <= GENERATED_IMAGE_PATH_PREFIX.length) {
    return GENERATED_IMAGE_PATH_PREFIX.startsWith(destination);
  }
  if (!destination.startsWith(GENERATED_IMAGE_PATH_PREFIX)) return false;
  return possibleEncodedImageIdPrefix(destination.slice(GENERATED_IMAGE_PATH_PREFIX.length));
}

/**
 * Hide a trailing, still-streaming generated-image marker until its closing
 * parenthesis arrives. Ordinary image syntax is restored as soon as it can no
 * longer become a canonical generated-image reference.
 */
export function hideTrailingIncompleteGeneratedImageMarkdown(source: string): string {
  const protectedRanges = codeRanges(source);
  for (let index = source.lastIndexOf("!["); index >= 0; index = source.lastIndexOf("![", index - 1)) {
    if (isEscaped(source, index)) continue;
    if (isIndentedCode(source, index)) continue;
    if (protectedRanges.some((range) => index >= range.start && index < range.end)) continue;
    return isIncompleteGeneratedImageMarkdown(source.slice(index)) ? source.slice(0, index) : source;
  }
  return source;
}

export type ImagePlaceholderResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "remove" }
  | { readonly kind: "replace"; readonly image: ChatImage };

export interface GeneratedImageLayout {
  readonly resolutions: readonly ImagePlaceholderResolution[];
}

/**
 * Resolve generated-image references exclusively by their stable IDs.
 * Ordinary Markdown images are preserved and missing or repeated generated
 * references are removed. Share the optional claims set when resolving
 * multiple Markdown fragments from the same response in one render pass.
 */
export function resolveGeneratedImageLayout(
  sources: readonly (string | null)[],
  images: readonly ChatImage[],
  claimedGeneratedImageIds: Set<string> = new Set<string>(),
): GeneratedImageLayout {
  const imagesById = new Map<string, ChatImage>();
  for (const image of images) {
    if (!imagesById.has(image.id)) imagesById.set(image.id, image);
  }

  const resolutions = sources.map((source): ImagePlaceholderResolution => {
    if (!isGeneratedImageReferenceSource(source)) return { kind: "preserve" };
    const id = parseGeneratedImageReferenceSource(source);
    const image = id ? imagesById.get(id) : undefined;
    if (!image || claimedGeneratedImageIds.has(image.id)) return { kind: "remove" };
    claimedGeneratedImageIds.add(image.id);
    return { kind: "replace", image };
  });

  return { resolutions };
}
