export const GENERATED_IMAGE_PATH_PREFIX = "/__datalens_generated_image__/";

export function createGeneratedImageId(toolCallId: string, ordinal: number): string {
  if (!toolCallId || !Number.isInteger(ordinal) || ordinal < 1) {
    throw new TypeError("生成图片 ID 需要有效的工具调用 ID 和正序编号");
  }
  return `ci:${toolCallId}:${ordinal}`;
}

export function generatedImageReferenceSource(id: string): string {
  if (!id) throw new TypeError("生成图片 ID 不能为空");
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
    return id && generatedImageReferenceSource(id) === normalized ? id : null;
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
