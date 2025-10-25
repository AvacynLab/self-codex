import { GraphDescriptorPayload, GraphDescriptorSchema } from "../tools/graph/snapshot.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/** Options influencing the Mermaid serialisation. */
/** Mapping of stigmergic tiers to CSS-like Mermaid styles. */
const STIG_CLASS_STYLES: Record<string, string> = {
  "stig-low": "fill:#f2e7fe,stroke:#c5a8ff,color:#311b92",
  "stig-medium": "fill:#d4b5ff,stroke:#8f5aff,color:#2a1a5e",
  "stig-high": "fill:#7b2cbf,stroke:#3c096c,color:#ffffff",
};

/** Mapping of Behaviour Tree statuses to Mermaid class definitions. */
const STATUS_CLASS_STYLES: Record<string, string> = {
  "bt-running": "stroke:#f4a261,stroke-width:3px,fill-opacity:0.95",
  "bt-success": "stroke:#2a9d8f,stroke-width:3px,fill-opacity:0.95",
  "bt-failure": "stroke:#e63946,stroke-width:3px,fill-opacity:0.95",
};

/** Possible Behaviour Tree states surfaced by the overlay support. */
export type BehaviorNodeStatus = "running" | "success" | "failure";

/** Optional overrides controlling how Behaviour Tree badges are rendered. */
export interface BehaviorStatusOverlayOptions {
  /** Mapping of node identifiers to their latest Behaviour Tree status. */
  statuses: Record<string, BehaviorNodeStatus | string>;
  /** Custom labels replacing the defaults (RUNNING/OK/KO). */
  labels?: Partial<Record<BehaviorNodeStatus, string>>;
}

/** Options controlling how stigmergic intensities are projected onto nodes. */
export interface StigmergyOverlayOptions {
  /** Intensity per node identifier as reported by the stigmergic field. */
  intensities: Record<string, number>;
  /** Ratio above which a node is considered medium intensity (defaults to 0.4). */
  mediumThreshold?: number;
  /** Ratio above which a node is considered high intensity (defaults to 0.75). */
  highThreshold?: number;
}

export interface MermaidRenderOptions {
  /** Graph orientation, defaults to left-to-right for workflows. */
  direction?: "LR" | "TB";
  /** Optional attribute used when the node label is missing. */
  labelAttribute?: string;
  /** Attribute appended on edges to highlight weights or costs. */
  weightAttribute?: string;
  /** Maximum number of characters kept in rendered labels. */
  maxLabelLength?: number;
  /** Optional overlay colouring nodes based on stigmergic intensity. */
  stigmergyOverlay?: StigmergyOverlayOptions;
  /** Optional overlay surfacing Behaviour Tree node statuses. */
  behaviorStatusOverlay?: BehaviorStatusOverlayOptions;
}

/**
 * Convert a graph descriptor into a Mermaid flowchart definition.
 *
 * The function performs light sanitisation on identifiers to keep the output
 * compatible with the Mermaid grammar while preserving determinism. Labels are
 * trimmed and truncated to avoid oversized diagrams.
 */
export function renderMermaidFromGraph(
  descriptor: GraphDescriptorPayload,
  options: MermaidRenderOptions = {},
): string {
  const parsed = GraphDescriptorSchema.parse(descriptor);
  const direction = options.direction ?? "LR";
  const maxLength = Math.max(8, options.maxLabelLength ?? 48);

  const stigOverlay = normaliseStigmergyOverlay(options.stigmergyOverlay);
  const statusOverlay = normaliseStatusOverlay(options.behaviorStatusOverlay);

  const idMap = new Map<string, string>();
  // Track the generated identifiers separately to avoid repeatedly scanning the
  // cache. This keeps the deterministic suffixing logic linear in the number
  // of nodes instead of quadratic when collisions appear.
  const usedIds = new Set<string>();
  const lines: string[] = [`graph ${direction}`];
  const classDefinitions = new Map<string, string>();
  const classAssignments: Array<{ nodeId: string; classes: string[] }> = [];

  for (const node of parsed.nodes) {
    const normalisedId = normaliseId(node.id, idMap, usedIds);
    let label = buildNodeLabel(node, options.labelAttribute, maxLength);
    const classes: string[] = [];

    if (stigOverlay) {
      const stigClass = resolveStigmergyClass(node.id, stigOverlay);
      if (stigClass) {
        classes.push(stigClass);
        ensureClassDefinition(classDefinitions, stigClass, STIG_CLASS_STYLES[stigClass]);
      }
    }

    if (statusOverlay) {
      const status = statusOverlay.statuses.get(node.id);
      if (status) {
        const badge = formatStatusBadge(status, statusOverlay.labels);
        label = `${label}\n${badge}`;
        const statusClass = STATUS_CLASS_BY_STATUS[status];
        classes.push(statusClass);
        ensureClassDefinition(classDefinitions, statusClass, STATUS_CLASS_STYLES[statusClass]);
      }
    }

    lines.push(`${normalisedId}["${escapeLabel(label)}"]`);
    if (classes.length > 0) {
      classAssignments.push({ nodeId: normalisedId, classes });
    }
  }

  for (const edge of parsed.edges) {
    const fromId = idMap.get(edge.from) ?? normaliseId(edge.from, idMap, usedIds);
    const toId = idMap.get(edge.to) ?? normaliseId(edge.to, idMap, usedIds);
    const label = buildEdgeLabel(edge, options.weightAttribute, maxLength);
    const hyperAnnotation = buildHyperEdgeAnnotation(edge);
    const combinedLabel = hyperAnnotation
      ? label
        ? `${label} ${hyperAnnotation}`
        : hyperAnnotation
      : label;
    const segment = combinedLabel ? ` -- "${combinedLabel}" --> ` : " --> ";
    lines.push(`${fromId}${segment}${toId}`);
  }

  if (classDefinitions.size > 0) {
    for (const [className, style] of classDefinitions) {
      lines.push(`classDef ${className} ${style};`);
    }
    for (const assignment of classAssignments) {
      lines.push(`class ${assignment.nodeId} ${assignment.classes.join(",")};`);
    }
  }

  return lines.join("\n");
}

function normaliseId(
  original: string,
  cache: Map<string, string>,
  used: Set<string>,
): string {
  const existing = cache.get(original);
  if (existing) {
    return existing;
  }
  const base = original
    .trim()
    // Replace characters Mermaid cannot accept in identifiers with a safe
    // underscore placeholder.
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_{2,}/g, "_");
  const candidate = base.length > 0 ? base : "node";
  let finalId = candidate;
  let counter = 1;
  while (used.has(finalId)) {
    counter += 1;
    finalId = `${candidate}_${counter}`;
  }
  cache.set(original, finalId);
  used.add(finalId);
  return finalId;
}

function buildNodeLabel(
  node: GraphDescriptorPayload["nodes"][number],
  fallbackAttribute: string | undefined,
  maxLength: number,
): string {
  const candidates: Array<string | undefined> = [node.label];
  if (fallbackAttribute && typeof node.attributes?.[fallbackAttribute] === "string") {
    candidates.push(String(node.attributes?.[fallbackAttribute]));
  }
  if (typeof node.attributes?.label === "string") {
    candidates.push(String(node.attributes.label));
  }
  candidates.push(node.id);
  const raw = candidates.find((value) => value && value.trim().length > 0) ?? node.id;
  return truncateLabel(raw.trim(), maxLength);
}

function buildEdgeLabel(
  edge: GraphDescriptorPayload["edges"][number],
  weightAttribute: string | undefined,
  maxLength: number,
): string | null {
  const candidates: Array<string | number | boolean | undefined> = [edge.label];
  if (typeof edge.weight === "number") {
    candidates.push(edge.weight);
  }
  if (weightAttribute) {
    candidates.push(edge.attributes?.[weightAttribute]);
  }
  if (typeof edge.attributes?.weight === "number") {
    candidates.push(edge.attributes.weight);
  }
  const raw = candidates.find((value) => value !== undefined && value !== null);
  if (raw === undefined || raw === null) {
    return null;
  }
  const text = typeof raw === "string" ? raw : String(raw);
  return escapeLabel(truncateLabel(text.trim(), maxLength));
}

function buildHyperEdgeAnnotation(edge: GraphDescriptorPayload["edges"][number]): string | null {
  const identifier = edge.attributes?.hyper_edge_id;
  if (typeof identifier !== "string") {
    return null;
  }
  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  let annotation = `[H:${trimmed}`;
  const pairIndex = edge.attributes?.hyper_edge_pair_index;
  if (typeof pairIndex === "number" && Number.isFinite(pairIndex)) {
    annotation += `#${pairIndex}`;
  }
  const sourceCardinality = edge.attributes?.hyper_edge_source_cardinality;
  const targetCardinality = edge.attributes?.hyper_edge_target_cardinality;
  if (
    typeof sourceCardinality === "number" &&
    Number.isFinite(sourceCardinality) &&
    typeof targetCardinality === "number" &&
    Number.isFinite(targetCardinality)
  ) {
    annotation += ` ${sourceCardinality}->${targetCardinality}`;
  }
  annotation += "]";

  return escapeLabel(annotation);
}

function truncateLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) {
    return label;
  }
  const slice = label.slice(0, maxLength - 1).trimEnd();
  return `${slice}…`;
}

function escapeLabel(label: string): string {
  // Escape backslashes first so subsequent replacements keep their semantics.
  return label
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/"/g, '\\"')
    // Brackets occasionally appear in labels; escape them so Mermaid does not
    // mistake them for node syntax.
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    // Replace remaining control characters with spaces to keep the diagram
    // readable if unexpected values slip through.
    .replace(/[\u0000-\u001f]/g, " ");
}

const STATUS_CLASS_BY_STATUS: Record<BehaviorNodeStatus, string> = {
  running: "bt-running",
  success: "bt-success",
  failure: "bt-failure",
};

const STATUS_BADGES: Record<BehaviorNodeStatus, { icon: string; label: string }> = {
  running: { icon: "⏱", label: "RUNNING" },
  success: { icon: "✅", label: "OK" },
  failure: { icon: "❌", label: "KO" },
};

function ensureClassDefinition(
  registry: Map<string, string>,
  className: string,
  style: string,
): void {
  if (!registry.has(className) && style) {
    registry.set(className, style);
  }
}

function formatStatusBadge(
  status: BehaviorNodeStatus,
  labels: BehaviorStatusOverlayOptions["labels"] | undefined,
): string {
  const defaults = STATUS_BADGES[status];
  const custom = labels?.[status];
  const text = custom && custom.trim().length > 0 ? custom.trim() : defaults.label;
  return `${defaults.icon} ${text}`;
}

interface NormalisedStigOverlay {
  intensities: Map<string, number>;
  mediumThreshold: number;
  highThreshold: number;
}

function normaliseStigmergyOverlay(
  overlay: StigmergyOverlayOptions | undefined,
): NormalisedStigOverlay | null {
  if (!overlay) {
    return null;
  }
  const intensities = new Map<string, number>();
  let max = 0;
  for (const [nodeId, value] of Object.entries(overlay.intensities)) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      intensities.set(nodeId, numeric);
      if (numeric > max) {
        max = numeric;
      }
    }
  }
  if (intensities.size === 0 || max <= 0) {
    return null;
  }
  const mediumRaw = overlay.mediumThreshold ?? 0.4;
  const highRaw = overlay.highThreshold ?? 0.75;
  const mediumThreshold = clamp01(mediumRaw);
  let highThreshold = clamp01(highRaw);
  if (highThreshold <= mediumThreshold) {
    highThreshold = Math.min(1, mediumThreshold + 0.1);
  }
  const normalised = new Map<string, number>();
  for (const [nodeId, value] of intensities) {
    normalised.set(nodeId, value / max);
  }
  return { intensities: normalised, mediumThreshold, highThreshold };
}

interface NormalisedStatusOverlay {
  statuses: Map<string, BehaviorNodeStatus>;
  labels?: BehaviorStatusOverlayOptions["labels"];
}

function normaliseStatusOverlay(
  overlay: BehaviorStatusOverlayOptions | undefined,
): NormalisedStatusOverlay | null {
  if (!overlay) {
    return null;
  }
  const statuses = new Map<string, BehaviorNodeStatus>();
  for (const [nodeId, value] of Object.entries(overlay.statuses)) {
    const normalised = normaliseStatus(value);
    if (normalised) {
      statuses.set(nodeId, normalised);
    }
  }
  if (statuses.size === 0) {
    return null;
  }
  return { statuses, labels: overlay.labels };
}

function normaliseStatus(value: unknown): BehaviorNodeStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalised = value.trim().toLowerCase();
  if (!normalised) {
    return null;
  }
  if (["running", "in_progress", "in-progress"].includes(normalised)) {
    return "running";
  }
  if (["success", "ok", "succeeded", "done", "passed"].includes(normalised)) {
    return "success";
  }
  if (["failure", "failed", "ko", "error", "stopped"].includes(normalised)) {
    return "failure";
  }
  return null;
}

function resolveStigmergyClass(nodeId: string, overlay: NormalisedStigOverlay): string | null {
  const intensity = overlay.intensities.get(nodeId);
  if (intensity === undefined) {
    return null;
  }
  if (intensity >= overlay.highThreshold) {
    return "stig-high";
  }
  if (intensity >= overlay.mediumThreshold) {
    return "stig-medium";
  }
  return "stig-low";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
