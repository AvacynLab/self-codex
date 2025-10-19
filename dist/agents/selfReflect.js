import { z } from "zod";
/**
 * Shape accepted by the {@link reflect} helper. The orchestrator forwards
 * high level metadata about the processed deliverable so the heuristic can
 * produce actionable feedback without relying on model calls.
 */
export const ReflectionInputSchema = z
    .object({
    /** Type of deliverable produced by the child (code, plan, text, …). */
    kind: z.string().min(1, "kind is required"),
    /** Optional original prompt or instructions. */
    input: z.unknown().optional(),
    /** Raw output produced by the child (text, JSON, artefact summaries). */
    output: z.unknown().optional(),
    /**
     * Additional metadata captured during evaluation (scores, timings,
     * artefact counts…). The shape is intentionally loose to remain stable.
     */
    meta: z.record(z.unknown()).optional(),
})
    .strict();
/**
 * Normalises arbitrary values into a textual blob so heuristic rules can be
 * applied consistently regardless of the original structure.
 */
function normaliseToText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normaliseToText(entry)).join("\n");
    }
    if (value && typeof value === "object") {
        return Object.values(value)
            .map((entry) => normaliseToText(entry))
            .join("\n");
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}
/**
 * Helper ensuring the reflection payload remains concise.
 */
function truncateList(values, limit) {
    return Array.from(values)
        .filter((entry) => entry.trim().length > 0)
        .slice(0, limit);
}
/**
 * Generates a self-reflection for the provided artefact. The implementation is
 * intentionally deterministic and lightweight so it can run synchronously
 * within the orchestrator after each child collection.
 */
export async function reflect(raw) {
    const input = ReflectionInputSchema.parse(raw);
    const combinedText = [input.input, input.output]
        .map((segment) => normaliseToText(segment))
        .filter((segment) => segment.length > 0)
        .join("\n\n");
    const lowered = combinedText.toLowerCase();
    const insights = new Set();
    const nextSteps = new Set();
    const risks = new Set();
    // Generic signals shared by every deliverable type.
    if (!combinedText.length) {
        insights.add("Aucune sortie exploitable n'a été détectée.");
        nextSteps.add("Vérifier que l'enfant a bien produit un livrable ou relancer la tâche.");
        risks.add("Sans livrable il est impossible de valider la progression du plan.");
    }
    else {
        insights.add("Un livrable exploitable est disponible pour analyse.");
    }
    const meta = input.meta ?? {};
    const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : null;
    if (durationMs && durationMs > 60_000) {
        risks.add("Le temps de génération est élevé, surveiller les budgets temps côté enfants.");
    }
    const metaScore = typeof meta.score === "number" ? meta.score : null;
    if (metaScore !== null) {
        if (metaScore >= 0.8) {
            insights.add("Le score qualitatif initial est élevé, la sortie semble solide.");
        }
        else if (metaScore < 0.5) {
            risks.add("Le score qualitatif est faible, prévoir une itération corrective.");
        }
    }
    switch (input.kind) {
        case "code": {
            insights.add("Le livrable contient du code source; vérifier la robustesse des tests.");
            if (!/test|expect|assert|describe|it/.test(lowered)) {
                nextSteps.add("Ajouter ou compléter des tests unitaires pour couvrir les cas critiques.");
            }
            else {
                insights.add("Des références à des tests sont présentes, pensez à confirmer leur exécution.");
            }
            if (/todo|fixme/.test(lowered)) {
                risks.add("Des marqueurs TODO/FIXME subsistent dans le code.");
                nextSteps.add("Supprimer les TODO/FIXME ou planifier leur résolution.");
            }
            if (/console\.log|debugger/.test(combinedText)) {
                risks.add("Du logging de debug est présent; nettoyer avant livraison.");
            }
            if (/eslint|lint|format/.test(lowered)) {
                insights.add("Le livrable mentionne une étape de lint/formatage.");
            }
            else {
                nextSteps.add("Exécuter le lint/formatage automatique pour uniformiser le code.");
            }
            break;
        }
        case "plan": {
            insights.add("Le livrable décrit un plan structuré.");
            const steps = combinedText.split(/\n+/).filter((line) => /^\s*(?:\d+\.|[-*•])/.test(line));
            if (steps.length < 3) {
                nextSteps.add("Ajouter davantage d'étapes détaillées pour sécuriser l'exécution.");
                risks.add("Le plan comporte trop peu d'étapes pour couvrir les dépendances.");
            }
            else {
                insights.add("Plusieurs étapes identifiées permettent de suivre la progression.");
            }
            if (!/risque|fallback|plan\s*b|mitigation/.test(lowered)) {
                nextSteps.add("Identifier les risques majeurs et proposer des plans de mitigation.");
            }
            if (/bloquant|retard/.test(lowered)) {
                risks.add("Des risques bloquants sont déjà listés, prévoir un suivi rapproché.");
            }
            break;
        }
        case "text": {
            insights.add("Le livrable est un texte analytique ou explicatif.");
            const sentences = combinedText.split(/[.!?]+/).filter((part) => part.trim().length > 0);
            const avgLength = sentences.length
                ? combinedText.replace(/\s+/g, " ").split(" ").length / sentences.length
                : combinedText.split(/\s+/).length;
            if (avgLength > 28) {
                risks.add("Les phrases sont longues; risque de perte de lisibilité.");
                nextSteps.add("Scinder les phrases longues et ajouter des intertitres.");
            }
            if (/\b(parce que|donc|ainsi)\b/.test(lowered)) {
                insights.add("Le raisonnement inclut des connecteurs logiques.");
            }
            else {
                nextSteps.add("Clarifier le raisonnement avec des connecteurs logiques explicites.");
            }
            if (!/exemple|illustration|cas/.test(lowered)) {
                nextSteps.add("Ajouter un exemple concret pour illustrer le propos.");
            }
            break;
        }
        default: {
            insights.add("Aucune heuristique spécifique pour ce type de livrable; appliquer une revue manuelle.");
            break;
        }
    }
    return {
        insights: truncateList(insights, 6),
        nextSteps: truncateList(nextSteps, 6),
        risks: truncateList(risks, 6),
        lessons: [],
    };
}
//# sourceMappingURL=selfReflect.js.map