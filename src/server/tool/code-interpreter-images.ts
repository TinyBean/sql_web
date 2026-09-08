import type { ChatImage } from "../../shared/contracts.ts";
import {
  isGeneratedImageReferenceName,
  isSemanticGeneratedImageId,
} from "../../shared/image-references.ts";

const MAX_IMAGE_COUNT = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = 2_800_000;
const PNG_SIGNATURE = "89504e470d0a1a0a";

function decodeCanonicalBase64(data: string): Buffer | null {
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

function persistedReferenceId(candidate: Record<string, unknown>): string | null {
  if (!("referenceId" in candidate)) return null;
  const { referenceId, referenceName } = candidate;
  if (
    typeof referenceId !== "string" || !isSemanticGeneratedImageId(referenceId) ||
    !isGeneratedImageReferenceName(referenceName)
  ) return null;
  const base = `ci-${referenceName}`;
  if (referenceId === base) return referenceId;
  if (!referenceId.startsWith(`${base}-`)) return null;
  const suffix = referenceId.slice(base.length + 1);
  return /^(?:[2-9]|[1-9]\d+)$/u.test(suffix) ? referenceId : null;
}

export function extractCodeInterpreterImages(
  toolCallId: string,
  details: unknown,
): ChatImage[] {
  if (!toolCallId) return [];
  if (
    typeof details !== "object" || details === null || !("kind" in details) ||
    details.kind !== "code_interpreter" || !("images" in details) ||
    !Array.isArray(details.images)
  ) return [];

  const images: ChatImage[] = [];
  for (const candidate of details.images.slice(0, MAX_IMAGE_COUNT)) {
    if (
      typeof candidate !== "object" || candidate === null ||
      !("mimeType" in candidate) || candidate.mimeType !== "image/png" ||
      !("data" in candidate) || typeof candidate.data !== "string" ||
      !("alt" in candidate) || typeof candidate.alt !== "string" ||
      candidate.data.length > MAX_IMAGE_BASE64_LENGTH
    ) continue;
    const bytes = decodeCanonicalBase64(candidate.data);
    if (
      !bytes || bytes.length > MAX_IMAGE_BYTES || bytes.length < 8 ||
      bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE
    ) continue;
    const referenceId = persistedReferenceId(candidate);
    if (referenceId === null) continue;
    if (candidate.alt !== candidate.referenceName) continue;
    images.push({
      id: referenceId,
      mimeType: "image/png",
      data: candidate.data,
      alt: candidate.alt,
    });
  }
  return images;
}
