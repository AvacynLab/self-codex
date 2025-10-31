import { createHash } from "node:crypto";

import type { StructuredDocument, StructuredSegment } from "./types.js";
import { type SegmentKind } from "./types.js";

/**
 * Kinds considered textual when deduplicating segments.  Only those segments
 * participate in the whitespace canonicalisation process.
 */
const TEXTUAL_KINDS: ReadonlySet<SegmentKind> = new Set([
  "title",
  "paragraph",
  "list",
  "caption",
  "code",
]);

/**
 * Replaces the provisional identifier assigned during extraction with the
 * definitive {@link docId}.  Segment identifiers are regenerated so they stay
 * dense after deduplication.
 */
export function finalizeDocId(document: StructuredDocument, docId: string): StructuredDocument {
  const trimmed = docId.trim();
  const finalId = trimmed.length > 0 ? trimmed : document.id;
  const segments = document.segments.map((segment, index) => ({
    ...segment,
    id: `${finalId}#${index + 1}`,
  }));
  return {
    ...document,
    id: finalId,
    segments,
  };
}

/**
 * Deduplicates textual segments by collapsing whitespace, normalising to NFC,
 * and hashing the resulting payload alongside the segment kind.  Non textual
 * segments retain their original text (figures, metadata...) and are
 * deduplicated using the combination of kind and source identifier.
 */
export function deduplicateSegments(document: StructuredDocument): StructuredDocument {
  const seen = new Set<string>();
  const segments: StructuredSegment[] = [];
  let fallbackTitle: string | undefined;

  for (const segment of document.segments) {
    const textual = TEXTUAL_KINDS.has(segment.kind);
    const normalisedText = textual ? normaliseText(segment.text) : segment.text.trim();

    if (textual && normalisedText.length === 0) {
      // Empty textual segments do not carry useful information.
      continue;
    }

    const hashKey = textual ? hashText(normalisedText, segment.kind) : undefined;
    const key = textual
      ? `${segment.kind}|${hashKey}`
      : `${segment.kind}|${segment.sourceId ?? segment.id}`;

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (segment.kind === "title" && !fallbackTitle) {
      fallbackTitle = normalisedText;
    }

    const next: StructuredSegment = {
      ...segment,
      text: textual ? normalisedText : segment.text,
    };
    segments.push(next);
  }

  const title = resolveDocumentTitle(document.title, fallbackTitle);

  return {
    ...document,
    title,
    segments,
  };
}

/** Collapses repeated whitespace, trims, and normalises the string to NFC. */
function normaliseText(value: string): string {
  return collapseWhitespace(value.normalize("NFC"));
}

/** Collapses repeated whitespace and trims the extremities. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Produces a deterministic hash for a textual segment. */
function hashText(text: string, kind: SegmentKind): string {
  return createHash("sha1").update(kind).update("\0").update(text).digest("hex");
}

/**
 * Returns the provided title when available, otherwise falls back to the first
 * extracted title segment with meaningful content.
 */
function resolveDocumentTitle(currentTitle: string | null, fallbackTitle: string | undefined): string | null {
  if (typeof currentTitle === "string") {
    const trimmed = currentTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallbackTitle ?? null;
}

