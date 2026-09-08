export const GENERATED_IMAGE_PATH_PREFIX = "/__datalens_generated_image__/";
export const GENERATED_IMAGE_REFERENCE_NAME_MAX_LENGTH = 24;

const GENERATED_IMAGE_REFERENCE_NAME_PATTERN =
  /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,23}$/u;
const SEMANTIC_GENERATED_IMAGE_ID_PATTERN =
  /^ci-[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,79}$/u;

export function isGeneratedImageReferenceName(value: unknown): value is string {
  return typeof value === "string" && GENERATED_IMAGE_REFERENCE_NAME_PATTERN.test(value);
}

export function isSemanticGeneratedImageId(value: unknown): value is string {
  return typeof value === "string" && SEMANTIC_GENERATED_IMAGE_ID_PATTERN.test(value);
}

export function reserveSemanticGeneratedImageId(
  referenceName: string,
  usedIds: Set<string>,
): string {
  if (!isGeneratedImageReferenceName(referenceName)) {
    throw new TypeError("生成图片引用名称格式无效");
  }
  const base = `ci-${referenceName}`;
  let id = base;
  for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
  usedIds.add(id);
  return id;
}

export function generatedImageReferenceSource(id: string): string {
  if (!isSemanticGeneratedImageId(id)) throw new TypeError("生成图片 ID 格式无效");
  const encodedId = encodeURIComponent(id).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${GENERATED_IMAGE_PATH_PREFIX}${encodedId}`;
}

export function parseGeneratedImageReferenceSource(source: string | null): string | null {
  const normalized = source?.trim() ?? "";
  if (!normalized.startsWith(GENERATED_IMAGE_PATH_PREFIX)) return null;
  const encodedId = normalized.slice(GENERATED_IMAGE_PATH_PREFIX.length);
  if (!encodedId || encodedId.includes("/")) return null;
  try {
    const id = decodeURIComponent(encodedId);
    return isSemanticGeneratedImageId(id) && generatedImageReferenceSource(id) === normalized
      ? id
      : null;
  } catch {
    return null;
  }
}

export function isGeneratedImageReferenceSource(source: string | null): boolean {
  return (source?.trim() ?? "").startsWith(GENERATED_IMAGE_PATH_PREFIX);
}

function markdownAltText(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function generatedImageMarkdown(id: string, alt: string): string {
  return `![${markdownAltText(alt)}](${generatedImageReferenceSource(id)})`;
}

const GENERATED_IMAGE_MARKDOWN_PATTERN =
  /!\[(?:\\.|[^\]\\\r\n])*\]\(\/__datalens_generated_image__\/[^)\s]+\)/gu;

export function stripGeneratedImageMarkdown(source: string): string {
  return source.replace(GENERATED_IMAGE_MARKDOWN_PATTERN, "");
}
