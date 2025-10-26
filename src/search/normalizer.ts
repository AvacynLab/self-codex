import type { StructuredDocument, StructuredSegment, StructuredSegmentKind } from "./types.js";

/**
 * Kinds considered textual when deduplicating segments.  Only those segments
 * participate in the whitespace canonicalisation process.
 */
const TEXTUAL_KINDS: ReadonlySet<StructuredSegmentKind> = new Set([
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
 * Deduplicates textual segments by collapsing whitespace and using the
 * `kind|text` tuple as the stable key.  Non textual segments retain their
 * original text (figures, metadata...) and are deduplicated using the
 * combination of kind and source identifier.
 */
export function deduplicateSegments(document: StructuredDocument): StructuredDocument {
  const seen = new Set<string>();
  const segments: StructuredSegment[] = [];

  for (const segment of document.segments) {
    const textual = TEXTUAL_KINDS.has(segment.kind);
    const normalisedText = textual ? collapseWhitespace(segment.text) : segment.text.trim();

    if (textual && normalisedText.length === 0) {
      // Empty textual segments do not carry useful information.
      continue;
    }

    const key = textual
      ? `${segment.kind}|${normalisedText}`
      : `${segment.kind}|${segment.sourceId ?? segment.id}`;

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const next: StructuredSegment = {
      ...segment,
      text: textual ? normalisedText : segment.text,
    };
    segments.push(next);
  }

  return {
    ...document,
    segments,
  };
}

/** Collapses repeated whitespace and trims the extremities. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

