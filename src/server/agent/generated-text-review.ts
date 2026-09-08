import { Marked } from "marked";
import type {
  InlineExtension,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChatImage } from "../../shared/contracts.ts";
import {
  generatedImageMarkdown,
  parseGeneratedImageReferenceSource,
} from "../../shared/image-references.ts";
import { extractCodeInterpreterImages } from "../tool/code-interpreter-images.ts";

export const IMAGE_REFERENCE_REVIEW_MESSAGE_TYPE = "sql_web.image_reference_review";

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface LocatedMarkdownImage {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly source: string;
  readonly alt: string;
}

export interface GeneratedTextReviewIssue {
  readonly ordinal: number;
  readonly alt: string;
  readonly reason: "unapproved_address" | "ambiguous_description";
}

export interface GeneratedTextReviewResult {
  readonly text: string;
  readonly referenceCount: number;
  readonly exactReferenceCount: number;
  readonly automaticRepairCount: number;
  readonly descriptionRepairCount: number;
  readonly ambiguousDescriptionCount: number;
  readonly duplicateReferenceCount: number;
  readonly unresolvedReferenceCount: number;
  readonly issues: readonly GeneratedTextReviewIssue[];
  readonly requiresModelReview: boolean;
}

type ReviewLogger = {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
};

type AgentMessage = MessageEndEvent["message"];
type AssistantMessage = Extract<AgentMessage, { readonly role: "assistant" }>;

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isIndentedCode(source: string, index: number): boolean {
  const lineStart = Math.max(
    source.lastIndexOf("\n", index - 1),
    source.lastIndexOf("\r", index - 1),
  ) + 1;
  return /^(?: {4,}|\t)/u.test(source.slice(lineStart, index));
}

function markdownCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let openFence: { readonly character: "`" | "~"; readonly length: number; readonly start: number } | null = null;
  let offset = 0;

  for (const lineWithEnding of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.replace(/(?:\r\n|\r|\n)$/u, "");
    if (openFence) {
      const closing = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line)?.[1] ?? "";
      if (closing[0] === openFence.character && closing.length >= openFence.length) {
        ranges.push({ start: openFence.start, end: offset + lineWithEnding.length });
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
  if (openFence) ranges.push({ start: openFence.start, end: source.length });

  const inExistingRange = (index: number): boolean => (
    ranges.some((range) => index >= range.start && index < range.end)
  );
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] !== "`" || isEscaped(source, cursor) || inExistingRange(cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (source[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - cursor;
    let closingEnd = source.length;
    let search = runEnd;
    while (search < source.length) {
      if (source[search] !== "`" || isEscaped(source, search) || inExistingRange(search)) {
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

  return ranges.sort((left, right) => left.start - right.start);
}

function locateMarkdownImages(source: string): LocatedMarkdownImage[] {
  const parsed: Array<{ readonly raw: string; readonly source: string; readonly alt: string }> = [];
  const parser = new Marked({
    renderer: {
      image(token) {
        parsed.push({ raw: token.raw, source: token.href, alt: token.text });
        return "";
      },
    },
  });
  parser.parse(source, { async: false, gfm: true });

  const codeRanges = markdownCodeRanges(source);
  const located: LocatedMarkdownImage[] = [];
  let cursor = 0;
  for (const reference of parsed) {
    let start = source.indexOf(reference.raw, cursor);
    while (start >= 0) {
      const inCode = codeRanges.some((range) => start >= range.start && start < range.end);
      if (!inCode && !isEscaped(source, start) && !isIndentedCode(source, start)) break;
      start = source.indexOf(reference.raw, start + 1);
    }
    if (start < 0) continue;
    located.push({
      ...reference,
      start,
      end: start + reference.raw.length,
    });
    cursor = start + reference.raw.length;
  }
  return located;
}

function applyImageReplacements(
  source: string,
  references: readonly LocatedMarkdownImage[],
  replacements: ReadonlyMap<number, string>,
): string {
  let result = source;
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const replacement = replacements.get(index);
    const reference = references[index];
    if (replacement === undefined || !reference) continue;
    result = result.slice(0, reference.start) + replacement + result.slice(reference.end);
  }
  return result;
}

function countPotentialMarkdownImages(source: string): number {
  let count = 0;
  source.replace(/!\[/gu, (_marker, offset: number) => {
    if (isEscaped(source, offset)) return "";
    count += 1;
    return "";
  });
  return count;
}

/**
 * Review every rendered Markdown image against the generated images from the
 * current user response. Unresolved and duplicate references remain in the
 * authored text for auditability; the browser is responsible for not rendering them.
 */
export function reviewGeneratedImageReferences(
  source: string,
  images: readonly ChatImage[],
): GeneratedTextReviewResult {
  let references: LocatedMarkdownImage[];
  try {
    references = locateMarkdownImages(source);
  } catch {
    const potentialReferenceCount = countPotentialMarkdownImages(source);
    return {
      text: source,
      referenceCount: potentialReferenceCount,
      exactReferenceCount: 0,
      automaticRepairCount: 0,
      descriptionRepairCount: 0,
      ambiguousDescriptionCount: 0,
      duplicateReferenceCount: 0,
      unresolvedReferenceCount: potentialReferenceCount,
      issues: Array.from({ length: potentialReferenceCount }, (_, index) => ({
        ordinal: index + 1,
        alt: "",
        reason: "unapproved_address" as const,
      })),
      requiresModelReview: potentialReferenceCount > 0,
    };
  }
  if (!references.length) {
    return {
      text: source,
      referenceCount: 0,
      exactReferenceCount: 0,
      automaticRepairCount: 0,
      descriptionRepairCount: 0,
      ambiguousDescriptionCount: 0,
      duplicateReferenceCount: 0,
      unresolvedReferenceCount: 0,
      issues: [],
      requiresModelReview: false,
    };
  }

  const imagesById = new Map<string, ChatImage>();
  for (const image of images) {
    if (!imagesById.has(image.id)) imagesById.set(image.id, image);
  }
  const distinctImages = [...imagesById.values()];
  const imagesByDescription = new Map<string, ChatImage | null>();
  for (const image of distinctImages) {
    imagesByDescription.set(
      image.alt,
      imagesByDescription.has(image.alt) ? null : image,
    );
  }
  const claimedIds = new Set<string>();
  const replacements = new Map<number, string>();
  const unresolvedIndices: number[] = [];
  let exactReferenceCount = 0;
  let duplicateReferenceCount = 0;

  for (const [index, reference] of references.entries()) {
    const id = parseGeneratedImageReferenceSource(reference.source);
    const image = id ? imagesById.get(id) : undefined;
    if (!image) {
      unresolvedIndices.push(index);
      continue;
    }
    if (claimedIds.has(image.id)) {
      duplicateReferenceCount += 1;
      continue;
    }
    claimedIds.add(image.id);
    exactReferenceCount += 1;
  }

  const issueReasons = new Map<number, GeneratedTextReviewIssue["reason"]>();
  const fallbackEligibleIndices: number[] = [];
  let descriptionRepairCount = 0;
  let ambiguousDescriptionCount = 0;

  for (const index of unresolvedIndices) {
    const reference = references[index]!;
    if (!reference.alt || !imagesByDescription.has(reference.alt)) {
      fallbackEligibleIndices.push(index);
      issueReasons.set(index, "unapproved_address");
      continue;
    }
    const image = imagesByDescription.get(reference.alt);
    if (!image) {
      ambiguousDescriptionCount += 1;
      issueReasons.set(index, "ambiguous_description");
      continue;
    }
    if (claimedIds.has(image.id)) {
      duplicateReferenceCount += 1;
      continue;
    }
    replacements.set(index, generatedImageMarkdown(image.id, reference.alt));
    claimedIds.add(image.id);
    descriptionRepairCount += 1;
  }

  let fallbackRepairCount = 0;
  const unclaimedImages = distinctImages.filter((image) => !claimedIds.has(image.id));
  if (
    ambiguousDescriptionCount === 0 &&
    fallbackEligibleIndices.length === 1 &&
    unclaimedImages.length === 1
  ) {
    const index = fallbackEligibleIndices[0]!;
    const image = unclaimedImages[0]!;
    const alt = references[index]?.alt || image.alt;
    replacements.set(index, generatedImageMarkdown(image.id, alt));
    issueReasons.delete(index);
    fallbackRepairCount = 1;
  }

  const issues: GeneratedTextReviewIssue[] = [...issueReasons.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, reason]) => ({
      ordinal: index + 1,
      alt: references[index]?.alt ?? "",
      reason,
    }));
  const automaticRepairCount = descriptionRepairCount + fallbackRepairCount;
  const unresolvedReferenceCount = issues.length;

  return {
    text: applyImageReplacements(source, references, replacements),
    referenceCount: references.length,
    exactReferenceCount,
    automaticRepairCount,
    descriptionRepairCount,
    ambiguousDescriptionCount,
    duplicateReferenceCount,
    unresolvedReferenceCount,
    issues,
    requiresModelReview: issues.length > 0,
  };
}

function assistantMessageText(message: AssistantMessage): string {
  return message.content
    .map((part) => part.type === "text" ? part.text : "")
    .join("");
}

function assistantHasToolCall(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

function replaceAssistantText(message: AssistantMessage, text: string): AssistantMessage {
  let replaced = false;
  const content = message.content.map((part) => {
    if (part.type !== "text") return part;
    if (replaced) return { ...part, text: "" };
    replaced = true;
    return { ...part, text };
  });
  if (!replaced) content.push({ type: "text", text });
  return { ...message, content };
}

function finalAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" &&
    (message.stopReason === "stop" || message.stopReason === "length") &&
    !assistantHasToolCall(message);
}

function reviewInstruction(
  originalText: string,
  result: GeneratedTextReviewResult,
  images: readonly ChatImage[],
): string {
  const allowedMarkdown = images.map((image) => generatedImageMarkdown(image.id, image.alt));
  return `上一条候选回答包含无法确认的 Markdown 图片地址。请复核并重新输出完整回答。

要求:
1. 只输出修正后的完整回答,不要解释复核过程。
2. 不得调用任何工具。
3. 只能使用 allowedMarkdown 中的图片 Markdown,每项最多一次;不得使用外链、data、artifact、sandbox、相对路径或其他图片地址。
4. 若无法判断某张图片应放在哪里,保留候选回答中的原始引用,不要猜测或删除;前端会阻止它渲染为图片。

<image_reference_review>
${JSON.stringify({ allowedMarkdown, issues: result.issues })}
</image_reference_review>

<candidate_answer>
${originalText}
</candidate_answer>`;
}

function reviewLogFields(
  sessionId: string,
  phase: "candidate" | "rewrite",
  result: GeneratedTextReviewResult,
): Readonly<Record<string, unknown>> {
  return {
    sessionId,
    phase,
    referenceCount: result.referenceCount,
    exactReferenceCount: result.exactReferenceCount,
    automaticRepairCount: result.automaticRepairCount,
    descriptionRepairCount: result.descriptionRepairCount,
    ambiguousDescriptionCount: result.ambiguousDescriptionCount,
    duplicateReferenceCount: result.duplicateReferenceCount,
    unresolvedReferenceCount: result.unresolvedReferenceCount,
  };
}

/** Create one session-local output gate for generated-image references. */
export function createGeneratedTextReviewExtension(logger: ReviewLogger): InlineExtension {
  return {
    name: "sql-web-generated-text-review",
    hidden: true,
    factory: (pi) => {
      const imagesById = new Map<string, ChatImage>();
      let reviewAttempted = false;
      let reviewActive = false;
      let pendingInstruction: string | null = null;

      const resetForUserMessage = (): void => {
        imagesById.clear();
        reviewAttempted = false;
        reviewActive = false;
        pendingInstruction = null;
      };

      pi.on("message_end", (event, context) => {
        if (event.message.role === "user") {
          resetForUserMessage();
          return;
        }
        if (event.message.role === "toolResult") {
          if (
            !reviewAttempted && event.message.toolName === "code_interpreter" &&
            event.message.isError !== true
          ) {
            for (const image of extractCodeInterpreterImages(
              event.message.toolCallId,
              event.message.details,
            )) {
              if (!imagesById.has(image.id)) imagesById.set(image.id, image);
            }
          }
          return;
        }
        if (!finalAssistantMessage(event.message)) return;

        const originalText = assistantMessageText(event.message);
        const images = [...imagesById.values()];
        const result = reviewGeneratedImageReferences(originalText, images);
        const sessionId = context.sessionManager.getSessionId();
        if (!result.referenceCount) {
          if (reviewActive) {
            logger.info(
              "agent.image_reference_review.checked",
              reviewLogFields(sessionId, "rewrite", result),
            );
            reviewActive = false;
          }
          return;
        }

        const phase = reviewAttempted ? "rewrite" : "candidate";
        logger.info("agent.image_reference_review.checked", reviewLogFields(sessionId, phase, result));
        if (result.requiresModelReview && !reviewAttempted) {
          pendingInstruction = reviewInstruction(originalText, result, images);
        } else if (reviewActive) {
          reviewActive = false;
        }
        if (result.text === originalText) return;
        return { message: replaceAssistantText(event.message, result.text) };
      });

      pi.on("turn_end", (_event, context) => {
        if (!pendingInstruction) return;
        const instruction = pendingInstruction;
        pendingInstruction = null;
        reviewAttempted = true;
        reviewActive = true;
        logger.warn("agent.image_reference_review.started", {
          sessionId: context.sessionManager.getSessionId(),
          allowedImageCount: imagesById.size,
        });
        pi.sendMessage({
          customType: IMAGE_REFERENCE_REVIEW_MESSAGE_TYPE,
          content: instruction,
          display: false,
          details: { allowedImageCount: imagesById.size },
        }, { deliverAs: "followUp" });
      });

      pi.on("tool_call", () => {
        if (!reviewActive) return;
        return {
          block: true,
          reason: "图片引用复核阶段不得调用工具,请直接输出修正后的完整回答",
        };
      });

      pi.on("agent_settled", (_event, context) => {
        if (!reviewActive) return;
        reviewActive = false;
        logger.warn("agent.image_reference_review.fallback", {
          sessionId: context.sessionManager.getSessionId(),
        });
      });
    },
  };
}
