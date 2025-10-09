/** Maximum number of fragment descriptions included in rationale details. */
const RATIONALE_LIST_LIMIT = 5;
/** Helper rounding numeric values to keep payloads compact. */
function round(value, decimals = 3) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
/** Normalises a source string for comparisons while preserving a display label. */
function normaliseSourceValue(source) {
    if (typeof source === "string" && source.trim().length > 0) {
        const trimmed = source.trim();
        return { key: trimmed.toLowerCase(), label: trimmed };
    }
    return { key: "unknown", label: "unknown" };
}
/** Normalises the user provided context into a deterministic representation. */
function normaliseContext(context) {
    const preferredSources = [];
    const preferredSourceSet = new Set();
    for (const raw of context?.preferredSources ?? []) {
        if (typeof raw !== "string") {
            continue;
        }
        const candidate = raw.trim();
        if (!candidate) {
            continue;
        }
        const key = candidate.toLowerCase();
        if (preferredSourceSet.has(key)) {
            continue;
        }
        preferredSourceSet.add(key);
        preferredSources.push({ key, label: candidate });
    }
    const excludeTasks = new Set();
    for (const raw of context?.excludeTasks ?? []) {
        if (typeof raw !== "string") {
            continue;
        }
        const candidate = raw.trim();
        if (!candidate) {
            continue;
        }
        excludeTasks.add(candidate);
    }
    let maxFragments = context?.maxFragments ?? 3;
    if (!Number.isFinite(maxFragments)) {
        maxFragments = 3;
    }
    maxFragments = Math.min(5, Math.max(1, Math.floor(maxFragments)));
    return { preferredSources, preferredSourceSet, excludeTasks, maxFragments };
}
/** Converts a map of missing dependencies into a serialisable array. */
function serialiseDependencyMap(map) {
    return Array.from(map.entries())
        .map(([task, deps]) => ({ task, dependencies: Array.from(deps).sort() }))
        .sort((left, right) => left.task.localeCompare(right.task));
}
/** Formats an array for rationale strings, trimming overly long lists. */
function formatList(values, limit = RATIONALE_LIST_LIMIT) {
    if (values.length === 0) {
        return "aucun";
    }
    if (values.length <= limit) {
        return values.join(", ");
    }
    const visible = values.slice(0, limit).join(", ");
    return `${visible} (+${values.length - limit} autres)`;
}
/**
 * Build deterministic groups of tasks (per preferred source + remainder) so
 * fragments stay concise and targeted.
 */
function groupTasks(pattern, includedTasks, context) {
    if (!context.preferredSources.length) {
        return [
            {
                id: `${pattern.plan}-all`,
                label: "plan complet",
                seeds: includedTasks,
                kind: "default",
            },
        ];
    }
    const groups = [];
    for (const preferred of context.preferredSources) {
        const seeds = includedTasks.filter((task) => normaliseSourceValue(task.source).key === preferred.key);
        if (seeds.length === 0) {
            continue;
        }
        groups.push({
            id: `${pattern.plan}-preferred-${preferred.key}`,
            label: `source ${preferred.label}`,
            seeds,
            kind: "preferred",
            preferredSourceKey: preferred.key,
        });
    }
    const remainder = includedTasks.filter((task) => !context.preferredSourceSet.has(normaliseSourceValue(task.source).key));
    if (remainder.length > 0) {
        groups.push({
            id: `${pattern.plan}-remainder`,
            label: "sources complémentaires",
            seeds: remainder,
            kind: "remainder",
        });
    }
    return groups;
}
/**
 * Builds a hierarchical fragment starting from the provided seed tasks. The
 * closure ensures dependencies present in the knowledge graph are included in
 * the fragment, preserving ordering for downstream BT compilation.
 */
function buildFragment(goal, fragmentId, groupLabel, seeds, includedTaskMap) {
    const selected = new Map();
    const queue = [];
    const seedIds = new Set();
    for (const seed of seeds) {
        if (selected.has(seed.id)) {
            seedIds.add(seed.id);
            continue;
        }
        selected.set(seed.id, seed);
        seedIds.add(seed.id);
        queue.push(seed);
    }
    while (queue.length > 0) {
        const current = queue.shift();
        for (const dependencyId of current.dependsOn) {
            const dependency = includedTaskMap.get(dependencyId);
            if (!dependency || selected.has(dependency.id)) {
                continue;
            }
            selected.set(dependency.id, dependency);
            queue.push(dependency);
        }
    }
    const depthCache = new Map();
    const visiting = new Set();
    const computeDepth = (taskId) => {
        if (depthCache.has(taskId)) {
            return depthCache.get(taskId);
        }
        if (visiting.has(taskId)) {
            return 1; // break cycles defensively
        }
        visiting.add(taskId);
        const record = selected.get(taskId);
        if (!record) {
            visiting.delete(taskId);
            depthCache.set(taskId, 1);
            return 1;
        }
        let maxDepth = 0;
        for (const dependencyId of record.dependsOn) {
            if (!selected.has(dependencyId)) {
                continue;
            }
            const depth = computeDepth(dependencyId);
            if (depth > maxDepth) {
                maxDepth = depth;
            }
        }
        visiting.delete(taskId);
        const finalDepth = maxDepth + 1;
        depthCache.set(taskId, finalDepth);
        return finalDepth;
    };
    const orderedTasks = Array.from(selected.values()).sort((left, right) => {
        const depthDelta = computeDepth(left.id) - computeDepth(right.id);
        if (depthDelta !== 0) {
            return depthDelta;
        }
        return left.id.localeCompare(right.id);
    });
    const nodes = orderedTasks.map((task) => {
        const { label: sourceLabel } = normaliseSourceValue(task.source);
        const attributes = {
            bt_tool: "noop",
            bt_input_key: `kg:${task.id}`,
            kg_goal: goal,
            kg_source: sourceLabel,
            kg_confidence: round(task.confidence),
            kg_seed: seedIds.has(task.id),
            kg_group: groupLabel,
        };
        if (typeof task.duration === "number" && Number.isFinite(task.duration)) {
            attributes.kg_duration = round(task.duration);
        }
        if (typeof task.weight === "number" && Number.isFinite(task.weight)) {
            attributes.kg_weight = round(task.weight);
        }
        return {
            id: task.id,
            kind: "task",
            label: task.label ?? undefined,
            attributes,
        };
    });
    let edgeIndex = 0;
    const edges = [];
    const seenPairs = new Set();
    for (const task of orderedTasks) {
        for (const dependencyId of task.dependsOn) {
            if (!selected.has(dependencyId)) {
                continue;
            }
            const key = `${dependencyId}->${task.id}`;
            if (seenPairs.has(key)) {
                continue;
            }
            seenPairs.add(key);
            edges.push({
                id: `${fragmentId}-edge-${++edgeIndex}`,
                from: { nodeId: dependencyId },
                to: { nodeId: task.id },
                label: "depends_on",
                attributes: { kg_dependency: true },
            });
        }
    }
    return {
        graph: {
            id: fragmentId,
            nodes,
            edges,
        },
        selectedTaskIds: new Set(selected.keys()),
        seedIds,
    };
}
/**
 * Analyse the knowledge graph and return plan fragments suitable for
 * orchestrator ingestion. The function never throws: the rationale explains
 * why no fragment could be produced instead of surfacing a transport error.
 */
export function suggestPlanFragments(knowledgeGraph, options) {
    const goal = options.goal.trim();
    const context = normaliseContext(options.context);
    if (!goal) {
        throw new Error("Plan goal must not be empty");
    }
    const pattern = knowledgeGraph.buildPlanPattern(goal);
    if (!pattern) {
        return {
            goal,
            fragments: [],
            rationale: [
                `Aucun plan connu pour '${goal}'. Utilise 'kg_insert' pour enregistrer des fragments avant de demander une suggestion.`,
            ],
            coverage: {
                total_tasks: 0,
                suggested_tasks: [],
                excluded_tasks: [],
                missing_dependencies: [],
                unknown_dependencies: [],
            },
            sources: [],
            preferred_sources_applied: [],
            preferred_sources_ignored: context.preferredSources.map((source) => source.label),
        };
    }
    const patternTaskMap = new Map(pattern.tasks.map((task) => [task.id, task]));
    const includedTasks = pattern.tasks.filter((task) => !context.excludeTasks.has(task.id));
    const includedTaskMap = new Map(includedTasks.map((task) => [task.id, task]));
    const excludedTasks = pattern.tasks
        .filter((task) => context.excludeTasks.has(task.id))
        .map((task) => task.id)
        .sort();
    const missingDependencies = new Map();
    const unknownDependencies = new Map();
    for (const task of includedTasks) {
        for (const dependencyId of task.dependsOn) {
            if (includedTaskMap.has(dependencyId)) {
                continue;
            }
            if (patternTaskMap.has(dependencyId)) {
                const list = missingDependencies.get(task.id) ?? new Set();
                list.add(dependencyId);
                missingDependencies.set(task.id, list);
            }
            else {
                const list = unknownDependencies.get(task.id) ?? new Set();
                list.add(dependencyId);
                unknownDependencies.set(task.id, list);
            }
        }
    }
    if (!includedTasks.length) {
        return {
            goal,
            fragments: [],
            rationale: [
                `Le graphe de connaissances contient ${pattern.tasks.length} tâche(s) pour '${goal}', mais elles ont été exclues par le contexte.`,
            ],
            coverage: {
                total_tasks: pattern.tasks.length,
                suggested_tasks: [],
                excluded_tasks: excludedTasks,
                missing_dependencies: serialiseDependencyMap(missingDependencies),
                unknown_dependencies: serialiseDependencyMap(unknownDependencies),
            },
            sources: [],
            preferred_sources_applied: [],
            preferred_sources_ignored: context.preferredSources.map((source) => source.label),
        };
    }
    const groups = groupTasks(pattern, includedTasks, context);
    const fragments = [];
    const rationale = [];
    const suggestedTaskIds = new Set();
    const globalSourceCounter = new Map();
    const appliedPreferred = new Set();
    const registerTask = (task) => {
        if (suggestedTaskIds.has(task.id)) {
            return;
        }
        suggestedTaskIds.add(task.id);
        const { key, label } = normaliseSourceValue(task.source);
        const counter = globalSourceCounter.get(key) ?? { label, count: 0 };
        counter.count += 1;
        globalSourceCounter.set(key, counter);
    };
    let processedGroups = 0;
    for (const group of groups) {
        if (fragments.length >= context.maxFragments) {
            break;
        }
        const fragmentId = `${goal}-fragment-${fragments.length + 1}`;
        const fragment = buildFragment(goal, fragmentId, group.label, group.seeds, includedTaskMap);
        fragments.push(fragment.graph);
        processedGroups += 1;
        for (const taskId of fragment.selectedTaskIds) {
            const task = includedTaskMap.get(taskId);
            if (task) {
                registerTask(task);
            }
        }
        if (group.preferredSourceKey) {
            appliedPreferred.add(group.preferredSourceKey);
        }
        const seedCount = fragment.seedIds.size;
        const dependencyOnlyCount = fragment.selectedTaskIds.size - seedCount;
        let fragmentRationale = `Fragment ${fragments.length} – ${group.label} : ${seedCount} tâche(s)`;
        if (dependencyOnlyCount > 0) {
            fragmentRationale += ` et ${dependencyOnlyCount} dépendance(s) de soutien`;
        }
        fragmentRationale += ".";
        rationale.push(fragmentRationale);
    }
    const omittedGroups = groups.length - processedGroups;
    if (omittedGroups > 0) {
        rationale.push(`${omittedGroups} groupe(s) supplémentaire(s) ignoré(s) en raison de la limite max_fragments=${context.maxFragments}.`);
    }
    const coverageSuggested = Array.from(suggestedTaskIds).sort();
    const sources = Array.from(globalSourceCounter.values())
        .map((entry) => ({ source: entry.label, tasks: entry.count }))
        .sort((left, right) => {
        if (right.tasks !== left.tasks) {
            return right.tasks - left.tasks;
        }
        return left.source.localeCompare(right.source);
    });
    const preferredSourcesApplied = context.preferredSources
        .filter((source) => appliedPreferred.has(source.key))
        .map((source) => source.label);
    const preferredSourcesIgnored = context.preferredSources
        .filter((source) => !appliedPreferred.has(source.key))
        .map((source) => source.label);
    const missingSerialised = serialiseDependencyMap(missingDependencies);
    const unknownSerialised = serialiseDependencyMap(unknownDependencies);
    const summary = `Plan '${goal}' : ${coverageSuggested.length}/${pattern.tasks.length} tâche(s) suggérées.`;
    rationale.unshift(summary);
    if (excludedTasks.length) {
        rationale.push(`Exclus par le contexte : ${formatList(excludedTasks)}.`);
    }
    if (missingSerialised.length) {
        const formatted = formatList(missingSerialised.map((entry) => `${entry.task} -> ${entry.dependencies.join(", ")}`));
        rationale.push(`Dépendances ignorées (présentes mais exclues) : ${formatted}.`);
    }
    if (unknownSerialised.length) {
        const formatted = formatList(unknownSerialised.map((entry) => `${entry.task} -> ${entry.dependencies.join(", ")}`));
        rationale.push(`Dépendances inconnues dans le graphe : ${formatted}.`);
    }
    if (!sources.length) {
        rationale.push("Aucune source associée aux tâches suggérées : toutes les tâches ont une provenance inconnue.");
    }
    return {
        goal,
        fragments,
        rationale,
        coverage: {
            total_tasks: pattern.tasks.length,
            suggested_tasks: coverageSuggested,
            excluded_tasks: excludedTasks,
            missing_dependencies: missingSerialised,
            unknown_dependencies: unknownSerialised,
        },
        sources,
        preferred_sources_applied: preferredSourcesApplied,
        preferred_sources_ignored: preferredSourcesIgnored,
    };
}
//# sourceMappingURL=assist.js.map