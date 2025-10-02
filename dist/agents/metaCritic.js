import { createHash } from "crypto";
/** Counts the number of non-empty lines in the evaluation context. */
function countNonEmptyLines(ctx) {
    return ctx.lines.reduce((total, line) => (line.trim().length > 0 ? total + 1 : total), 0);
}
/** Utility ensuring scores stay within the `[0, 1]` range. */
function clampScore(value) {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
/** Splits text into words while preserving simple alpha-numeric tokens. */
function tokeniseWords(text) {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}
/** Produces a deterministic fingerprint used for traceability. */
function fingerprintPayload(raw) {
    const hash = createHash("sha1");
    hash.update(raw.slice(0, 8_192));
    return hash.digest("hex").slice(0, 16);
}
/**
 * Builds an evaluation context reused across heuristics to avoid repeatedly
 * recomputing expensive derived data (tokenisation, sentence splitting, ...).
 */
function buildContext(output, kind) {
    const raw = output ?? "";
    const lines = raw.split(/\r?\n/);
    const words = tokeniseWords(raw);
    const sentences = raw
        .split(/[.!?]+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);
    const uniqueWords = new Set(words).size;
    return {
        kind,
        raw,
        lower: raw.toLowerCase(),
        lines,
        words,
        uniqueWords,
        sentences,
    };
}
/**
 * Heuristic looking for markers typically associated with incomplete work.
 */
function computeCompleteness(ctx) {
    let score = 1;
    const negatives = [];
    const suggestions = [];
    const blockers = ["todo", "fixme", "tbd", "not implemented", "???", "placeholder"];
    for (const marker of blockers) {
        if (ctx.lower.includes(marker)) {
            score -= 0.3;
            negatives.push(`Le texte contient le marqueur '${marker}'.`);
            suggestions.push("Remplacer les marqueurs TODO/FIXME par une implémentation concrète.");
        }
    }
    if (ctx.words.length < 20 && ctx.kind !== "artifact") {
        score -= 0.2;
        negatives.push("La sortie est trop courte pour couvrir les objectifs annoncés.");
        suggestions.push("Développer davantage les actions attendues et les résultats obtenus.");
    }
    if (ctx.kind === "code" && /throw new Error\(\s*['\"]not implemented/i.test(ctx.raw)) {
        score -= 0.35;
        negatives.push("Une exception 'not implemented' est levée dans le code.");
        suggestions.push("Fournir une implémentation fonctionnelle avant livraison.");
    }
    if (ctx.kind === "plan" && countNonEmptyLines(ctx) <= 2) {
        score -= 0.3;
        negatives.push("Le plan ne détaille pas clairement les étapes.");
        suggestions.push("Ajouter des étapes explicites pour guider l'exécution.");
    }
    if (negatives.length === 0) {
        negatives.push("La sortie couvre l'ensemble des points attendus.");
    }
    return {
        score: clampScore(score),
        feedback: negatives,
        suggestions,
    };
}
/**
 * Scores the structural clarity of the output by examining the presence of
 * headings, bullet lists and sentence length.
 */
function computeClarity(ctx) {
    let score = 1;
    const feedback = [];
    const suggestions = [];
    const averageSentenceLength = ctx.sentences.length > 0 ? ctx.words.length / ctx.sentences.length : ctx.words.length;
    if (averageSentenceLength > 35) {
        score -= 0.35;
        feedback.push("Les phrases sont extrêmement longues (moyenne supérieure à 35 mots), ce qui nuit à la lisibilité.");
        suggestions.push("Découper les longues phrases en segments plus courts et explicites.");
    }
    else if (averageSentenceLength > 22) {
        // Plans et textes non structurés peuvent devenir opaques avant même la
        // barre des 30 mots ; appliquer une pénalité douce améliore la
        // sensibilité du critique sans sanctionner les paragraphes concis.
        score -= ctx.kind === "plan" ? 0.25 : 0.15;
        feedback.push("Les phrases sont longues (moyenne supérieure à 22 mots), ce qui rend la lecture dense.");
        suggestions.push("Introduire davantage de ponctuation ou des listes pour aérer les idées principales.");
    }
    const hasBullet = ctx.lines.some((line) => /^\s*[-*\d+]/.test(line));
    if (!hasBullet && ctx.kind !== "artifact" && ctx.kind !== "code") {
        score -= 0.2;
        feedback.push("Aucune structuration en listes ou en étapes n'est présente.");
        suggestions.push("Introduire des listes numérotées ou à puces pour guider le lecteur.");
    }
    if (ctx.kind === "code") {
        const indentationIssues = ctx.lines.filter((line) => line.startsWith(" ") && (line.length - line.trimStart().length) % 2 === 1);
        if (indentationIssues.length > 0) {
            score -= 0.1;
            feedback.push("L'indentation du code est irrégulière (mélange d'espaces).");
            suggestions.push("Uniformiser l'indentation (ex. 2 espaces ou tabulation cohérente).");
        }
    }
    else if (ctx.kind === "plan" && countNonEmptyLines(ctx) <= 2) {
        score -= 0.2;
        feedback.push("Le plan tient en un seul bloc, ce qui complique la navigation.");
        suggestions.push("Découper le plan en étapes distinctes avec retours à la ligne.");
    }
    if (feedback.length === 0) {
        feedback.push("La structure est claire et facile à suivre.");
    }
    return {
        score: clampScore(score),
        feedback,
        suggestions,
    };
}
/**
 * Evaluates technical quality for code artefacts. The heuristic looks for
 * typical smells (usage of `any`, absence of exports, console logs, ...).
 */
function computeCodeQuality(ctx) {
    if (ctx.kind !== "code") {
        return { score: 1, feedback: ["Pas de vérification spécifique au code requise."], suggestions: [] };
    }
    let score = 1;
    const feedback = [];
    const suggestions = [];
    if (/\bany\b/.test(ctx.raw)) {
        score -= 0.2;
        feedback.push("Le type `any` est utilisé, ce qui réduit la sûreté du typage.");
        suggestions.push("Remplacer `any` par un type explicite pour documenter la structure attendue.");
    }
    if (/console\.log/.test(ctx.raw)) {
        score -= 0.3;
        feedback.push("Le code contient des `console.log` qui devraient être retirés en production.");
        suggestions.push("Supprimer les logs de debug ou les protéger derrière un drapeau de diagnostic.");
    }
    if (/\btodo\b|\btbd\b/.test(ctx.lower)) {
        score -= 0.2;
        feedback.push("Le code contient des TODO qui doivent être résolus avant livraison.");
        suggestions.push("Remplacer les TODO par une implémentation concrète ou supprimer les marqueurs.");
    }
    if (/throw\s+new\s+error/i.test(ctx.lower)) {
        score -= 0.2;
        feedback.push("Le code lève une erreur intentionnelle à la place d'une logique métier.");
        suggestions.push("Implémenter la fonctionnalité au lieu de lever une erreur.");
    }
    const opening = (ctx.raw.match(/\{/g) ?? []).length;
    const closing = (ctx.raw.match(/\}/g) ?? []).length;
    if (opening !== closing) {
        score -= 0.25;
        feedback.push("Les accolades ouvrantes/fermantes ne sont pas équilibrées.");
        suggestions.push("Vérifier la fermeture de tous les blocs et conditions.");
    }
    if (!/export\s+(?:default\s+)?(function|class|const|async)/.test(ctx.raw)) {
        score -= 0.1;
        feedback.push("Aucun symbole exporté n'est détecté, rendant le module difficile à réutiliser.");
        suggestions.push("Exporter explicitement la fonction ou la classe principale.");
    }
    if (feedback.length === 0) {
        feedback.push("Le code est propre et ne présente pas de défaut manifeste.");
    }
    return {
        score: clampScore(score),
        feedback,
        suggestions,
    };
}
/**
 * Penalises the absence de tests ou d'exemples vérifiables.
 */
function computeTestingDiscipline(ctx) {
    if (ctx.kind !== "code" && ctx.kind !== "plan") {
        return { score: 1, feedback: ["Pas d'exigence de tests explicites."], suggestions: [] };
    }
    let score = 1;
    const feedback = [];
    const suggestions = [];
    const hasTestSignals = /(describe\(|it\(|test\(|expect\(|assert\()/i.test(ctx.raw);
    if (!hasTestSignals) {
        score -= 0.6;
        feedback.push("Aucune trace de tests automatisés ou de validation n'est présente.");
        suggestions.push("Ajouter au minimum un scénario de test (unit ou e2e) pour vérifier le comportement.");
    }
    else {
        feedback.push("Des références aux tests sont présentes dans la sortie.");
    }
    return {
        score: clampScore(score),
        feedback,
        suggestions,
    };
}
/**
 * Estimates the risk level by cherchant des indices d'erreurs ou d'incertitudes.
 */
function computeRisk(ctx) {
    let score = 1;
    const feedback = [];
    const suggestions = [];
    const riskyPatterns = ["hack", "limitation", "risk", "attention", "caveat", "approximation"];
    const hits = riskyPatterns.filter((pattern) => ctx.lower.includes(pattern));
    if (hits.length > 0) {
        score -= 0.2;
        feedback.push(`Risque signalé via les termes : ${hits.join(", ")}.`);
        suggestions.push("Documenter les mesures d'atténuation ou corriger les risques identifiés.");
    }
    if (/\b(?:bug|failure|crash|broken)\b/.test(ctx.lower)) {
        score -= 0.2;
        feedback.push("Le texte mentionne des bogues ou des pannes non résolues.");
        suggestions.push("Décrire les correctifs appliqués ou les plans d'action précis.");
    }
    if (/throw\s+new\s+error/i.test(ctx.lower)) {
        score -= 0.35;
        feedback.push("Le code lève explicitement une erreur pour indiquer une implémentation manquante.");
        suggestions.push("Remplacer l'exception par une logique opérationnelle ou gérer le cas prévu.");
    }
    if (/\btodo\b|\btbd\b/.test(ctx.lower)) {
        score -= 0.2;
        feedback.push("Des sections TODO restent en suspens, ce qui augmente le risque.");
        suggestions.push("Remplacer les TODO par des actions ou des décisions concrètes.");
    }
    if (feedback.length === 0) {
        feedback.push("Aucun risque majeur identifié dans la sortie.");
    }
    return {
        score: clampScore(score),
        feedback,
        suggestions,
    };
}
/**
 * Provides a lightweight default mapping when the caller omits explicit
 * criteria. This keeps the API ergonomic for higher level orchestrators.
 */
function defaultCriteriaFor(kind) {
    if (kind === "code") {
        return [
            { id: "completeness", description: "Implémentation complète" },
            { id: "clarity", description: "Lisibilité du code" },
            { id: "testing", description: "Présence de tests" },
            { id: "risk", description: "Gestion des risques" },
        ];
    }
    if (kind === "plan") {
        return [
            { id: "completeness", description: "Couverture des étapes" },
            { id: "clarity", description: "Lisibilité" },
            { id: "risk", description: "Risques identifiés" },
        ];
    }
    return [
        { id: "completeness", description: "Couverture du sujet" },
        { id: "clarity", description: "Clarté rédactionnelle" },
    ];
}
/**
 * Central registry mapping criterion identifiers to heuristic implementations.
 */
const CRITERION_HANDLERS = {
    completeness: computeCompleteness,
    clarity: computeClarity,
    testing: computeTestingDiscipline,
    risk: computeRisk,
    quality: computeCodeQuality,
    maintainability: computeCodeQuality,
};
/**
 * Lightweight rule-based critic producing structured reviews for orchestrator
 * outputs. The implementation favours transparency: each score is traceable to
 * concrete heuristics making it suitable for CI gating.
 */
export class MetaCritic {
    /**
     * Reviews a textual artefact and returns a quantitative assessment enriched
     * with actionable suggestions.
     */
    review(output, kind, criteria) {
        const context = buildContext(output, kind);
        const selectedCriteria = criteria.length > 0 ? criteria : defaultCriteriaFor(kind);
        const breakdown = [];
        const aggregatedFeedback = [];
        const aggregatedSuggestions = [];
        let weightedScore = 0;
        let totalWeight = 0;
        for (const criterion of selectedCriteria) {
            const handler = CRITERION_HANDLERS[criterion.id] ?? computeClarity;
            const { score, feedback, suggestions } = handler(context);
            const weight = criterion.weight ?? 1;
            weightedScore += score * weight;
            totalWeight += weight;
            aggregatedFeedback.push(...feedback);
            aggregatedSuggestions.push(...suggestions);
            breakdown.push({
                criterion: criterion.id,
                score: clampScore(score),
                reasoning: feedback.join(" "),
            });
        }
        if (kind === "code") {
            // Ensure the code quality heuristic is accounted for even if the caller
            // omitted an explicit criterion. This keeps the guard rails active.
            const explicit = selectedCriteria.some((criterion) => criterion.id === "quality" || criterion.id === "maintainability");
            if (!explicit) {
                const fallback = computeCodeQuality(context);
                weightedScore += fallback.score;
                totalWeight += 1;
                aggregatedFeedback.push(...fallback.feedback);
                aggregatedSuggestions.push(...fallback.suggestions);
                breakdown.push({
                    criterion: "quality",
                    score: fallback.score,
                    reasoning: fallback.feedback.join(" "),
                });
            }
        }
        const overall = totalWeight > 0 ? clampScore(weightedScore / totalWeight) : 0;
        const uniqueFeedback = Array.from(new Set(aggregatedFeedback.filter((entry) => entry.trim().length > 0)));
        const uniqueSuggestions = Array.from(new Set(aggregatedSuggestions.filter((entry) => entry.trim().length > 0)));
        let verdict;
        if (overall >= 0.8) {
            verdict = "pass";
        }
        else if (overall >= 0.5) {
            verdict = "warn";
        }
        else {
            verdict = "fail";
        }
        // Provide at least one positive feedback to avoid purely negative reviews.
        if (uniqueFeedback.length === 0) {
            uniqueFeedback.push("La sortie est cohérente avec les attentes de l'orchestrateur.");
        }
        return {
            overall,
            verdict,
            feedback: uniqueFeedback,
            suggestions: uniqueSuggestions,
            breakdown,
            fingerprint: fingerprintPayload(context.raw),
        };
    }
}
