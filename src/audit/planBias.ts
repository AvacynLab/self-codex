import { PlanStep } from "../strategies/hypotheses.js";

/** Bias types detected within a plan. */
export type PlanBiasType = "anchoring" | "monoculture" | "missing_alternatives" | "risk_blind";

/** Descriptor for a bias along with suggested corrective actions. */
export interface PlanBiasInsight {
  type: PlanBiasType;
  severity: "low" | "medium" | "high";
  explanation: string;
  recommendedActions: string[];
}

/** Result returned by {@link analysePlanBias}. */
export interface PlanBiasReport {
  insights: PlanBiasInsight[];
  hasCriticalBias: boolean;
}

/** Options altering the bias detection heuristics. */
export interface PlanBiasOptions {
  minimumDiversityTags?: number;
  explorationTags?: string[];
  highRiskThreshold?: number;
  lowRiskDiversity?: number;
}

const DEFAULT_OPTIONS: Required<
  Pick<PlanBiasOptions, "minimumDiversityTags" | "explorationTags" | "highRiskThreshold" | "lowRiskDiversity">
> = {
  minimumDiversityTags: 2,
  explorationTags: ["explore", "alternative", "research"],
  highRiskThreshold: 0.7,
  lowRiskDiversity: 0.3,
};

/**
 * Analyses a plan and detects common biases such as anchoring, monoculture and
 * a lack of exploratory steps.
 */
export function analysePlanBias(steps: PlanStep[], options: PlanBiasOptions = {}): PlanBiasReport {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const insights: PlanBiasInsight[] = [];

  const anchoringInsight = detectAnchoring(steps);
  if (anchoringInsight) {
    insights.push(anchoringInsight);
  }

  const monocultureInsight = detectMonoculture(steps, mergedOptions);
  if (monocultureInsight) {
    insights.push(monocultureInsight);
  }

  const explorationInsight = detectMissingExploration(steps, mergedOptions);
  if (explorationInsight) {
    insights.push(explorationInsight);
  }

  const riskInsight = detectRiskBlindness(steps, mergedOptions);
  if (riskInsight) {
    insights.push(riskInsight);
  }

  insights.sort((left, right) => severityScore(right.severity) - severityScore(left.severity));

  return {
    insights,
    hasCriticalBias: insights.some((insight) => insight.severity === "high"),
  };
}

function detectAnchoring(steps: PlanStep[]): PlanBiasInsight | null {
  if (steps.length < 3) {
    return null;
  }
  const firstDomain = steps[0].domain ?? steps[0].tags?.[0];
  if (!firstDomain) {
    return null;
  }
  const anchoredCount = steps.filter((step) => step.domain === firstDomain || step.tags?.includes(firstDomain)).length;
  if (anchoredCount / steps.length < 0.5) {
    return null;
  }
  return {
    type: "anchoring",
    severity: "medium",
    explanation: `La majorité des étapes restent ancrées sur le domaine initial « ${firstDomain} » sans remise en question.`,
    recommendedActions: [
      "Introduire une étape d'analyse indépendante pour challenger la première hypothèse.",
      "Assigner un clone chargé de proposer une alternative radicalement différente.",
    ],
  };
}

function detectMonoculture(steps: PlanStep[], options: Required<PlanBiasOptions>): PlanBiasInsight | null {
  if (steps.length === 0) {
    return null;
  }

  const diversitySet = new Set<string>();
  const domainCounts = new Map<string, number>();
  for (const step of steps) {
    for (const tag of step.tags ?? []) {
      if (tag.trim().length > 0) {
        diversitySet.add(tag.toLowerCase());
      }
    }
    if (step.domain) {
      const normalised = step.domain.toLowerCase();
      diversitySet.add(normalised);
      domainCounts.set(normalised, (domainCounts.get(normalised) ?? 0) + 1);
    }
  }

  const dominantRatio = Math.max(...domainCounts.values(), 0) / steps.length;
  if (diversitySet.size >= options.minimumDiversityTags && dominantRatio < 0.7) {
    return null;
  }

  const severity: PlanBiasInsight["severity"] = dominantRatio >= 0.8 ? "high" : "medium";

  return {
    type: "monoculture",
    severity,
    explanation:
      "Les étapes partagent les mêmes expertises ou domaines, laissant peu de place à la diversité des approches.",
    recommendedActions: [
      "Injecter une étape dédiée à une perspective externe (ex: UX, sécurité).",
      "Créer une hypothèse alternative focalisée sur un autre domaine.",
    ],
  };
}

function detectMissingExploration(steps: PlanStep[], options: Required<PlanBiasOptions>): PlanBiasInsight | null {
  const explorationTags = new Set(options.explorationTags.map((tag) => tag.toLowerCase()));
  const hasExploration = steps.some((step) => {
    if (step.tags) {
      return step.tags.some((tag) => explorationTags.has(tag.toLowerCase()));
    }
    return false;
  });
  if (hasExploration) {
    return null;
  }
  return {
    type: "missing_alternatives",
    severity: "medium",
    explanation: "Aucune étape ne couvre l'exploration d'alternatives ou la collecte de signaux contradictoires.",
    recommendedActions: [
      "Ajouter une tâche ‘explore alternative X’ explicitement marquée comme exploration.",
      "Planifier une revue croisée avec un autre clone pour challenger la solution principale.",
    ],
  };
}

function detectRiskBlindness(steps: PlanStep[], options: Required<PlanBiasOptions>): PlanBiasInsight | null {
  if (steps.length === 0) {
    return null;
  }
  const averageRisk = steps.reduce((acc, step) => acc + step.risk, 0) / steps.length;
  if (averageRisk <= options.lowRiskDiversity) {
    return null;
  }
  const highRiskSteps = steps.filter((step) => step.risk >= options.highRiskThreshold);
  if (highRiskSteps.length === 0) {
    return null;
  }
  return {
    type: "risk_blind",
    severity: "medium",
    explanation: "Plusieurs étapes présentent un risque élevé sans contre-mesure explicite.",
    recommendedActions: [
      "Ajouter une étape de mitigation des risques identifiés (plan B).",
      "Répartir les tâches risquées entre plusieurs clones pour réduire la concentration.",
    ],
  };
}

function severityScore(severity: PlanBiasInsight["severity"]): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}
