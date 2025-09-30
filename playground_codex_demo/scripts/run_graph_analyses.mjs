#!/usr/bin/env node
/**
 * Script de démonstration pour exécuter les tâches de graphes décrites dans
 * la checklist MCP. Il s'appuie sur la bibliothèque locale Graph Forge pour
 * (1) compiler un graphe défini en DSL, (2) appliquer une mutation contrôlée,
 * (3) calculer plusieurs algorithmes (plus courts chemins, centralité,
 * chemins contraints), (4) simuler une planification à parallélisme limité et
 * (5) générer des exports structurés (JSON, Mermaid, DOT) accompagnés de
 * rapports Markdown. Toutes les écritures sont confinées au dossier
 * `playground_codex_demo` conformément aux contraintes du projet.
 */

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { compileSource } from '../../graph-forge/dist/compiler.js';
import { GraphModel } from '../../graph-forge/dist/model.js';
import { detectCycles } from '../../graph-forge/dist/algorithms/cycles.js';
import { topologicalSort } from '../../graph-forge/dist/algorithms/topologicalSort.js';
import { degreeCentrality } from '../../graph-forge/dist/algorithms/centrality.js';
import { betweennessCentrality } from '../../graph-forge/dist/algorithms/brandes.js';
import { kShortestPaths } from '../../graph-forge/dist/algorithms/kShortestPaths.js';
import { constrainedShortestPath } from '../../graph-forge/dist/algorithms/constraints.js';
import { criticalPath } from '../../graph-forge/dist/algorithms/criticalPath.js';

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const workspaceDir = dirname(scriptDir);
const logsDir = join(workspaceDir, 'logs');
const reportsDir = join(workspaceDir, 'reports');
const graphsDir = join(workspaceDir, 'graphs');
const exportsDir = join(workspaceDir, 'exports');

/**
 * Registre des appels d'outils simulés afin de tracer l'entrée exacte, un
 * résumé du résultat, le verdict associé et les artefacts produits.
 * Chaque entrée est sérialisée dans `logs/graph_tool_calls.json` et relayée
 * dans le rapport Markdown de synthèse.
 */
const toolCalls = [];

function recordCall({ tool, input, output, summary, verdict, artefacts = [] }) {
  toolCalls.push({ tool, input, output, summary, verdict, artefacts });
}

function escapeMarkdownPipes(value) {
  return value.replace(/\|/g, '\\|');
}

async function fileExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Charge le fichier DSL et renvoie le graphe compilé ainsi que ses analyses.
 */
async function loadBaseGraph() {
  const sourcePath = join(graphsDir, 'pipeline.gf');
  const source = await readFile(sourcePath, 'utf8');
  return {
    sourcePath,
    source,
    compiled: compileSource(source)
  };
}

/**
 * Copie les nœuds et arêtes d'un graphe puis injecte un nœud de déploiement
 * avec ses dépendances. Les attributs sont clonés pour éviter toute mutation
 * partagée avec le modèle original.
 */
function buildMutatedGraph(graph) {
  const nodes = graph.listNodes().map((node) => ({
    id: node.id,
    attributes: { ...node.attributes }
  }));
  const edges = graph.listEdges().map((edge) => ({
    from: edge.from,
    to: edge.to,
    attributes: { ...edge.attributes }
  }));

  if (!nodes.some((node) => node.id === 'deploy_stage')) {
    nodes.push({
      id: 'deploy_stage',
      attributes: {
        label: 'Déploiement staging',
        duration: 5,
        cost: 3.3
      }
    });
  }

  const deployEdges = [
    { from: 'package_artifacts', to: 'deploy_stage', attributes: { weight: 4 } },
    { from: 'docs_generate', to: 'deploy_stage', attributes: { weight: 3 } }
  ];

  for (const edge of deployEdges) {
    if (!edges.some((existing) => existing.from === edge.from && existing.to === edge.to)) {
      edges.push(edge);
    }
  }

  const directives = new Map(graph.directives ?? []);
  return new GraphModel(graph.name, nodes, edges, directives);
}

/**
 * Convertit un graphe en structure JSON sérialisable.
 */
function graphToSerializable(graph) {
  const directives = {};
  if (graph.directives instanceof Map) {
    for (const [key, value] of graph.directives.entries()) {
      directives[key] = value;
    }
  }
  return {
    name: graph.name,
    nodes: graph.listNodes().map((node) => ({ id: node.id, attributes: node.attributes })),
    edges: graph.listEdges().map((edge) => ({ from: edge.from, to: edge.to, attributes: edge.attributes })),
    directives
  };
}

/**
 * Calcule des métriques synthétiques pour un graphe : moyenne des degrés,
 * profondeur topologique et nœuds critiques identifiés via la centralité.
 */
function summarizeGraph(graph) {
  const nodeCount = graph.listNodes().length;
  const edgeCount = graph.listEdges().length;
  const degrees = degreeCentrality(graph);
  const totalDegree = degrees.reduce((sum, entry) => sum + entry.total, 0);
  const averageDegree = nodeCount > 0 ? totalDegree / nodeCount : 0;

  const indegree = new Map();
  for (const node of graph.listNodes()) {
    indegree.set(node.id, 0);
  }
  for (const edge of graph.listEdges()) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const topoOrder = topologicalSort(graph);
  const layerByNode = new Map();
  for (const node of topoOrder) {
    const predecessors = graph.listEdges().filter((edge) => edge.to === node).map((edge) => edge.from);
    const layer = predecessors.length === 0
      ? 0
      : Math.max(...predecessors.map((pred) => (layerByNode.get(pred) ?? 0) + 1));
    layerByNode.set(node, layer);
  }

  const layers = Array.from(layerByNode.entries()).reduce((acc, [node, layer]) => {
    if (!acc[layer]) {
      acc[layer] = [];
    }
    acc[layer].push(node);
    return acc;
  }, {});

  const betweenness = betweennessCentrality(graph, {
    weighted: true,
    weightAttribute: 'weight',
    normalise: true
  }).sort((a, b) => b.score - a.score);

  const topCritical = betweenness.slice(0, 3);

  return {
    nodeCount,
    edgeCount,
    averageDegree,
    layers,
    topoOrder,
    betweenness,
    topCritical
  };
}

/**
 * Produit la notation Mermaid du graphe actuel.
 */
function toMermaid(graph) {
  const lines = ['flowchart TD'];
  for (const node of graph.listNodes()) {
    const label = node.attributes.label ?? node.id;
    lines.push(`  ${node.id}[${label}]`);
  }
  for (const edge of graph.listEdges()) {
    const weight = edge.attributes.weight !== undefined ? ` |${edge.attributes.weight}|` : '';
    lines.push(`  ${edge.from} -->${weight} ${edge.to}`);
  }
  return lines.join('\n');
}

/**
 * Produit la notation DOT du graphe actuel.
 */
function toDot(graph) {
  const lines = ['digraph Pipeline {', '  rankdir=LR;'];
  for (const node of graph.listNodes()) {
    const label = node.attributes.label ?? node.id;
    lines.push(`  ${node.id} [label="${label}"];`);
  }
  for (const edge of graph.listEdges()) {
    const weight = edge.attributes.weight !== undefined ? `[label="${edge.attributes.weight}"]` : '';
    lines.push(`  ${edge.from} -> ${edge.to} ${weight};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Extrait les durées et coûts à partir des attributs des nœuds.
 */
function extractNodeAttributes(graph) {
  const durations = new Map();
  const costs = new Map();
  for (const node of graph.listNodes()) {
    const duration = Number(node.attributes.duration ?? 1);
    const cost = Number(node.attributes.cost ?? 0);
    durations.set(node.id, duration);
    costs.set(node.id, cost);
  }
  return { durations, costs };
}

/**
 * Simule un ordonnancement avec un parallélisme maximal.
 */
function simulateSchedule(graph, durations, maxParallel = 2) {
  const indegree = new Map();
  const predecessors = new Map();
  for (const node of graph.listNodes()) {
    indegree.set(node.id, 0);
    predecessors.set(node.id, []);
  }
  for (const edge of graph.listEdges()) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    predecessors.get(edge.to).push(edge.from);
  }

  const ready = [];
  const timeline = new Map();
  const events = [];
  const active = [];

  for (const node of graph.listNodes()) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      ready.push({ node: node.id, earliest: 0, started: false });
    }
  }

  let completed = 0;
  let time = 0;
  const totalTasks = graph.listNodes().length;

  const sortReady = () => {
    ready.sort((a, b) => {
      if (a.earliest !== b.earliest) {
        return a.earliest - b.earliest;
      }
      const durationA = durations.get(a.node) ?? 1;
      const durationB = durations.get(b.node) ?? 1;
      if (durationA !== durationB) {
        return durationB - durationA; // prioriser les durées longues pour limiter le makespan
      }
      return a.node.localeCompare(b.node);
    });
  };

  sortReady();

  const finishTask = (task) => {
    active.splice(active.indexOf(task), 1);
    events.push({ type: 'finish', node: task.node, time: task.finish });
    completed += 1;
    for (const successor of graph.getOutgoing(task.node)) {
      const target = successor.to;
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if ((indegree.get(target) ?? 0) === 0) {
        const preds = predecessors.get(target) ?? [];
        const earliest = preds.length === 0
          ? task.finish
          : Math.max(...preds.map((pred) => (timeline.get(pred)?.finish ?? 0)));
        ready.push({ node: target, earliest, started: false });
        sortReady();
      }
    }
  };

  while (completed < totalTasks) {
    const finishingNow = active.filter((task) => Math.abs(task.finish - time) < 1e-9);
    for (const task of finishingNow) {
      finishTask(task);
    }

    let startedSomething = false;
    sortReady();
    for (const entry of ready) {
      if (entry.started) {
        continue;
      }
      if (entry.earliest > time || active.length >= maxParallel) {
        continue;
      }
      const duration = durations.get(entry.node) ?? 1;
      const start = Math.max(time, entry.earliest);
      const finish = start + duration;
      timeline.set(entry.node, { start, finish });
      active.push({ node: entry.node, start, finish });
      entry.started = true;
      events.push({ type: 'start', node: entry.node, time: start });
      startedSomething = true;
    }

    if (completed >= totalTasks) {
      break;
    }

    if (!startedSomething) {
      const nextFinish = active.length > 0 ? Math.min(...active.map((task) => task.finish)) : Number.POSITIVE_INFINITY;
      const nextReady = ready
        .filter((entry) => !entry.started)
        .reduce((min, entry) => Math.min(min, entry.earliest), Number.POSITIVE_INFINITY);
      const nextEvent = Math.min(nextFinish, nextReady);
      if (!Number.isFinite(nextEvent)) {
        throw new Error('Simulation bloquée : aucun événement futur détecté');
      }
      time = nextEvent;
      const finishing = active.filter((task) => Math.abs(task.finish - time) < 1e-9);
      for (const task of finishing) {
        finishTask(task);
      }
    } else {
      const nextFinish = active.length > 0 ? Math.min(...active.map((task) => task.finish)) : time;
      if (nextFinish > time) {
        time = nextFinish;
      }
    }
  }

  const makespan = Math.max(...Array.from(timeline.values()).map((entry) => entry.finish));
  events.sort((a, b) => a.time - b.time || (a.type === 'finish' ? 1 : -1));

  return { makespan, events, timeline };
}

/**
 * Génère les combinaisons d'accélération (expedite) pour optimisation.
 */
function buildExpediteScenarios(baseDurations) {
  return [
    { node: 'test_integration', target: 6, deltaCost: 1.4, label: 'Tests intégration parallélisés' },
    { node: 'build_bundle', target: 5, deltaCost: 1.0, label: 'Build incrémental' },
    { node: 'docs_generate', target: 2, deltaCost: 0.6, label: 'Templates docs précompilés' },
    { node: 'package_artifacts', target: 3, deltaCost: 0.7, label: 'Packaging cache compressé' }
  ].filter((option) => baseDurations.get(option.node) > option.target);
}

/**
 * Applique une sélection d'options d'accélération et renvoie les nouvelles
 * durées ainsi que le coût additionnel.
 */
function applyScenario(baseDurations, selection) {
  const adjusted = new Map(baseDurations);
  let extraCost = 0;
  const appliedLabels = [];
  for (const option of selection) {
    adjusted.set(option.node, option.target);
    extraCost += option.deltaCost;
    appliedLabels.push(option.label);
  }
  return { durations: adjusted, extraCost, labels: appliedLabels };
}

/**
 * Détermine les solutions Pareto (non dominées) parmi les combinaisons
 * candidate selon le couple (makespan, cost).
 */
function paretoFront(results) {
  return results.filter((candidate) => {
    return !results.some((other) => {
      if (other === candidate) {
        return false;
      }
      const dominates = other.makespan <= candidate.makespan && other.totalCost <= candidate.totalCost
        && (other.makespan < candidate.makespan || other.totalCost < candidate.totalCost);
      return dominates;
    });
  });
}

async function main() {
  await mkdir(logsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(graphsDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });

  const baseGraph = await loadBaseGraph();
  const compiled = baseGraph.compiled;
  const mutated = buildMutatedGraph(compiled.graph);

  recordCall({
    tool: 'graph_generate',
    input: {
      sourcePath: relative(workspaceDir, baseGraph.sourcePath),
      source: baseGraph.source
    },
    output: {
      name: compiled.graph.name,
      nodeCount: compiled.graph.listNodes().length,
      edgeCount: compiled.graph.listEdges().length
    },
    summary: `${compiled.graph.listNodes().length} nœuds / ${compiled.graph.listEdges().length} arêtes générés depuis pipeline.gf`,
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, join(graphsDir, 'demo_graph.json'))]
  });

  recordCall({
    tool: 'graph_mutate',
    input: {
      addedNode: 'deploy_stage',
      addedEdges: [
        { from: 'package_artifacts', to: 'deploy_stage' },
        { from: 'docs_generate', to: 'deploy_stage' }
      ]
    },
    output: {
      nodeCount: mutated.listNodes().length,
      edgeCount: mutated.listEdges().length
    },
    summary: `Mutation appliquée : ajout de deploy_stage → ${mutated.listNodes().length} nœuds, ${mutated.listEdges().length} arêtes`,
    verdict: 'SIMULATED_OK'
  });

  const serialisedGraph = graphToSerializable(mutated);
  await writeFile(join(graphsDir, 'demo_graph.json'), `${JSON.stringify(serialisedGraph, null, 2)}\n`, 'utf8');

  const mermaid = toMermaid(mutated);
  const dotContent = toDot(mutated);

  await writeFile(join(exportsDir, 'demo_graph.mmd'), `${mermaid}\n`, 'utf8');
  await writeFile(join(exportsDir, 'demo_graph.dot'), `${dotContent}\n`, 'utf8');
  await writeFile(join(exportsDir, 'demo_graph.json'), `${JSON.stringify(serialisedGraph, null, 2)}\n`, 'utf8');

  recordCall({
    tool: 'graph_export',
    input: { format: 'json', target: relative(workspaceDir, join(exportsDir, 'demo_graph.json')) },
    output: { size: Buffer.byteLength(JSON.stringify(serialisedGraph)) },
    summary: 'Export JSON complet pour inspection automatisée',
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, join(exportsDir, 'demo_graph.json'))]
  });

  recordCall({
    tool: 'graph_export',
    input: { format: 'mermaid', target: relative(workspaceDir, join(exportsDir, 'demo_graph.mmd')) },
    output: { lineCount: mermaid.split('\n').length },
    summary: 'Diagramme Mermaid généré pour visualisation textuelle',
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, join(exportsDir, 'demo_graph.mmd'))]
  });

  recordCall({
    tool: 'graph_export',
    input: { format: 'dot', target: relative(workspaceDir, join(exportsDir, 'demo_graph.dot')) },
    output: { lineCount: dotContent.split('\n').length },
    summary: 'Export DOT prêt pour Graphviz',
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, join(exportsDir, 'demo_graph.dot'))]
  });
  const cycles = detectCycles(mutated);
  const summary = summarizeGraph(mutated);

  recordCall({
    tool: 'graph_validate',
    input: { checks: ['cycles'] },
    output: { hasCycle: cycles.hasCycle, cycleCount: (cycles.cycles ?? []).length },
    summary: cycles.hasCycle ? 'Cycles détectés' : 'Pas de cycle détecté',
    verdict: cycles.hasCycle ? 'SIMULATED_WARNING' : 'SIMULATED_OK'
  });

  recordCall({
    tool: 'graph_summarize',
    input: { metrics: ['averageDegree', 'layers', 'betweenness'] },
    output: {
      nodeCount: summary.nodeCount,
      edgeCount: summary.edgeCount,
      averageDegree: summary.averageDegree,
      topCritical: summary.topCritical
    },
    summary: `Résumé : ${summary.nodeCount} nœuds, degré moyen ${summary.averageDegree.toFixed(2)}`,
    verdict: 'SIMULATED_OK'
  });

  const kPaths = kShortestPaths(mutated, 'lint_core', 'deploy_stage', 3, {
    weightAttribute: 'weight'
  });

  recordCall({
    tool: 'graph_paths_k_shortest',
    input: { source: 'lint_core', target: 'deploy_stage', k: 3, weightAttribute: 'weight' },
    output: kPaths.map((path) => ({ distance: path.distance, path: path.path })),
    summary: `${kPaths.length} chemins calculés (meilleur coût ${kPaths[0]?.distance ?? 'N/A'})`,
    verdict: 'SIMULATED_OK'
  });

  const constrained = constrainedShortestPath(mutated, 'lint_core', 'deploy_stage', {
    avoidNodes: ['test_integration'],
    weightAttribute: 'weight'
  });

  recordCall({
    tool: 'graph_paths_constrained',
    input: { source: 'lint_core', target: 'deploy_stage', avoidNodes: ['test_integration'], weightAttribute: 'weight' },
    output: {
      status: constrained.status,
      path: constrained.path,
      distance: constrained.distance
    },
    summary: constrained.path.length > 0
      ? `Chemin alternatif trouvé (coût ${constrained.distance})`
      : 'Aucun chemin alternatif respectant la contrainte',
    verdict: constrained.status === 'found' ? 'SIMULATED_OK' : 'SIMULATED_WARNING'
  });

  const centrality = summary.betweenness;

  recordCall({
    tool: 'graph_centrality_betweenness',
    input: { weighted: true, weightAttribute: 'weight', normalise: true },
    output: centrality.slice(0, 5).map((entry) => ({ node: entry.node, score: entry.score })),
    summary: `Top pivots : ${centrality.slice(0, 3).map((entry) => entry.node).join(', ')}`,
    verdict: 'SIMULATED_OK'
  });

  const { durations, costs } = extractNodeAttributes(mutated);
  const simulation = simulateSchedule(mutated, durations, 2);
  const simulationLog = {
    makespan: simulation.makespan,
    events: simulation.events,
    timeline: Object.fromEntries(simulation.timeline.entries())
  };
  await writeFile(
    join(logsDir, 'simulation_events.json'),
    `${JSON.stringify(simulationLog, null, 2)}\n`,
    'utf8'
  );

  recordCall({
    tool: 'graph_simulate',
    input: { maxParallel: 2 },
    output: { makespan: simulation.makespan, eventCount: simulation.events.length },
    summary: `Simulation terminée (makespan ${simulation.makespan})`,
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, join(logsDir, 'simulation_events.json'))]
  });

  const baseCost = Array.from(costs.values()).reduce((sum, value) => sum + value, 0);

  const critical = criticalPath(mutated, { weightAttribute: 'weight' });

  recordCall({
    tool: 'graph_critical_path',
    input: { weightAttribute: 'weight' },
    output: { path: critical.path, length: critical.length },
    summary: `Chemin critique (${critical.path.join(' → ')})`,
    verdict: 'SIMULATED_OK'
  });

  const scenarios = buildExpediteScenarios(durations);
  const scenarioResults = [];
  for (let mask = 0; mask < 1 << scenarios.length; mask += 1) {
    const selected = scenarios.filter((_, index) => (mask & (1 << index)) !== 0);
    const { durations: adjusted, extraCost, labels } = applyScenario(durations, selected);
    const sim = simulateSchedule(mutated, adjusted, 2);
    scenarioResults.push({
      key: labels.join(' + ') || 'Baseline',
      labels,
      makespan: sim.makespan,
      totalCost: baseCost + extraCost,
      extraCost,
      timeline: Object.fromEntries(sim.timeline.entries())
    });
  }

  scenarioResults.sort((a, b) => a.makespan - b.makespan || a.totalCost - b.totalCost);
  const bestMono = scenarioResults[0];
  const pareto = paretoFront(scenarioResults);

  recordCall({
    tool: 'graph_optimize',
    input: { objective: 'makespan', scenarios: scenarios.map((option) => option.label) },
    output: { best: bestMono.key, makespan: bestMono.makespan, totalCost: bestMono.totalCost },
    summary: `Scénario optimal retenu : ${bestMono.key} (makespan ${bestMono.makespan})`,
    verdict: 'SIMULATED_OK'
  });

  recordCall({
    tool: 'graph_optimize_moo',
    input: { objectives: ['makespan', 'cost'] },
    output: pareto.map((entry) => ({ key: entry.key, makespan: entry.makespan, totalCost: entry.totalCost })),
    summary: `${pareto.length} solutions Pareto`,
    verdict: pareto.length > 0 ? 'SIMULATED_OK' : 'SIMULATED_WARNING'
  });

  await writeFile(
    join(logsDir, 'graph_tool_calls.json'),
    `${JSON.stringify(toolCalls, null, 2)}\n`,
    'utf8'
  );

  const overviewMd = `# Synthèse des opérations de graphe\n\n` +
    `## Génération et mutation\n` +
    `- Graphe source : \`${compiled.graph.name}\` (8 nœuds initiaux).\n` +
    `- Mutation appliquée : ajout du nœud \`deploy_stage\` et de 2 arêtes sortant de \`package_artifacts\` et \`docs_generate\`.\n` +
    `- Total final : **${summary.nodeCount} nœuds**, **${summary.edgeCount} arêtes**.\n\n` +
    `## Validation\n` +
    `- Cycle détecté : ${cycles.hasCycle ? 'oui' : 'non'}.\n` +
    `- Ordre topologique (${summary.topoOrder.length} nœuds) : ${summary.topoOrder.join(' → ')}.\n\n` +
    `## Statistiques\n` +
    `- Degré moyen : ${summary.averageDegree.toFixed(2)}.\n` +
    `- Couches topologiques :\n` +
    Object.entries(summary.layers)
      .map(([level, nodes]) => `  - Niveau ${level} : ${nodes.join(', ')}`)
      .join('\n') +
    `\n- Nœuds pivots (centralité d'intermédiarité normalisée) :\n` +
    summary.topCritical
      .map((entry) => `  - ${entry.node} (${entry.score.toFixed(3)})`)
      .join('\n') +
    `\n`;

  await writeFile(join(reportsDir, 'graph_overview.md'), `${overviewMd}\n`, 'utf8');

  const algorithmsMd = `# Algorithmes de chemins et centralité\n\n` +
    `## k=3 plus courts chemins (lint_core → deploy_stage)\n` +
    kPaths.map((path, index) => `- Chemin ${index + 1} : ${path.path.join(' → ')} (coût ${path.distance})`).join('\n') +
    `\n\n` +
    `## Chemin contraint (évite test_integration)\n` +
    `- Statut : ${constrained.status}.\n` +
    (constrained.path.length > 0
      ? `- Chemin trouvé : ${constrained.path.join(' → ')} (coût ${constrained.distance}).\n`
      : `- Aucun chemin alternatif disponible sans passer par test_integration.\n`) +
    `- Nœuds filtrés : ${constrained.filteredNodes.join(', ') || 'aucun'}.\n` +
    `- Notes : ${constrained.notes.join(', ') || 'RAS'}.\n\n` +
    `## Centralité d'intermédiarité\n` +
    centrality
      .map((entry) => `- ${entry.node} : ${entry.score.toFixed(3)}`)
      .join('\n') +
    `\n`;

  await writeFile(join(reportsDir, 'graph_algorithms.md'), `${algorithmsMd}\n`, 'utf8');

  const simulationMdLines = [];
  simulationMdLines.push('# Résultats de simulation et optimisation');
  simulationMdLines.push('');
  simulationMdLines.push('## Simulation de référence (parallélisme max = 2)');
  simulationMdLines.push(`- Makespan : **${simulation.makespan}** unités de temps.`);
  simulationMdLines.push('- Chronologie :');
  for (const [node, window] of Array.from(simulation.timeline.entries())) {
    simulationMdLines.push(`  - ${node} : démarrage ${window.start}, fin ${window.finish}`);
  }
  simulationMdLines.push('');
  simulationMdLines.push('## Chemin critique (poids = weight)');
  simulationMdLines.push(`- Longueur totale : ${critical.length}.`);
  simulationMdLines.push(`- Chemin : ${critical.path.join(' → ') || 'N/A'}.`);
  simulationMdLines.push('');
  simulationMdLines.push('## Optimisation (objectif makespan)');
  simulationMdLines.push(`- Solution retenue : ${bestMono.key} (makespan ${bestMono.makespan}, coût total ${bestMono.totalCost.toFixed(2)}).`);
  simulationMdLines.push('');
  simulationMdLines.push('## Solutions Pareto (makespan, coût total)');
  for (const entry of pareto) {
    simulationMdLines.push(`- ${entry.key} : makespan ${entry.makespan}, coût ${entry.totalCost.toFixed(2)}`);
  }
  simulationMdLines.push('');

  await writeFile(join(reportsDir, 'scheduling_results.md'), `${simulationMdLines.join('\n')}\n`, 'utf8');

  const visualsMd = `# Exports disponibles\n\n` +
    `- [demo_graph.json](../exports/demo_graph.json) — structure sérialisée (nœuds, arêtes, attributs).\n` +
    `- [demo_graph.mmd](../exports/demo_graph.mmd) — diagramme Mermaid (prévisualisation locale via un éditeur Markdown compatib`+
    `le ou \`npm run build\` suivi d'un rendu avec \`node_modules/.bin/mmdc\` si disponible).\n` +
    `- [demo_graph.dot](../exports/demo_graph.dot) — graphviz DOT (rendu hors-ligne avec \`dot -Tpng exports/demo_graph.dot -O\` `+
    `depuis \`playground_codex_demo/\`).\n`;
  await writeFile(join(reportsDir, 'visuals.md'), `${visualsMd}\n`, 'utf8');

  const childMergePath = join(reportsDir, 'children_merge.json');
  const childrenFanoutPath = join(reportsDir, 'children_fanout.md');
  const childLogPath = join(logsDir, 'children_orchestration_log.json');

  let childMerge = null;
  if (await fileExists(childMergePath)) {
    const raw = await readFile(childMergePath, 'utf8');
    childMerge = JSON.parse(raw);
  }

  let childLog = [];
  if (await fileExists(childLogPath)) {
    const raw = await readFile(childLogPath, 'utf8');
    childLog = JSON.parse(raw);
  }

  const finalReportLines = [];
  finalReportLines.push('# Rapport final');
  finalReportLines.push('');
  finalReportLines.push('## Outils et scripts exécutés');
  finalReportLines.push('- Graph Forge (compilation DSL + analyses) — OK.');
  finalReportLines.push('- Script local `run_graph_analyses.mjs` (génération, mutation, algorithmes, simulation, exports, journal) — OK.');
  if (await fileExists(childrenFanoutPath)) {
    finalReportLines.push('- Script local `run_children_fanout.mjs` (plan_fanout, child_create/send/status/collect, plan_join, plan_reduce) — OK.');
  } else {
    finalReportLines.push('- Script local `run_children_fanout.mjs` — non exécuté (artefacts absents).');
  }
  finalReportLines.push('');
  finalReportLines.push('## Résultats clés');
  finalReportLines.push(`- Graphe final : ${summary.nodeCount} nœuds, ${summary.edgeCount} arêtes, ${cycles.hasCycle ? 'cycle détecté' : 'aucun cycle détecté'}.`);
  finalReportLines.push(`- Chemins : ${kPaths.length} variantes de lint_core à deploy_stage, coût minimal ${kPaths[0]?.distance ?? 'N/A'}.`);
  finalReportLines.push(`- Centralité : nœuds critiques ${summary.topCritical.map((entry) => entry.node).join(', ')}.`);
  finalReportLines.push(`- Makespan simulé : ${simulation.makespan}, chemin critique ${critical.path.join(' → ')}.`);
  finalReportLines.push(`- Optimisation : meilleur scénario ${bestMono.key} (makespan ${bestMono.makespan}, coût total ${bestMono.totalCost.toFixed(2)}).`);
  if (childMerge) {
    const childCount = Object.keys(childMerge.children ?? {}).length;
    const slowestStage = childMerge.children?.['child-gamma']?.slowest;
    const flaggedMetrics = childMerge.children?.['child-beta']?.flagged ?? [];
    finalReportLines.push(`- Orchestration enfants : ${childCount} modules générés, stage le plus lent = ${slowestStage?.stage ?? 'N/A'} (${slowestStage ? slowestStage.meanDuration.toFixed(2) : 'N/A'}).`);
    if (flaggedMetrics.length > 0) {
      finalReportLines.push(`- Contrôles QA : ${flaggedMetrics.length} métriques signalées (${flaggedMetrics.map((metric) => metric.name).join(', ')}).`);
    }
  }
  finalReportLines.push('');
  finalReportLines.push('## Vérifications récentes');
  const timestamp = new Date().toISOString();
  finalReportLines.push(`- ${timestamp} — Script \`run_graph_analyses.mjs\` relancé pour rafraîchir les exports, la simulation et le journal des tools.`);
  if (childLog.length > 0) {
    finalReportLines.push(`- Dernière orchestration enfants : ${childMerge?.timestamp ?? 'horodatage inconnu'} (voir \`reports/children_fanout.md\`).`);
  }
  finalReportLines.push('');
  finalReportLines.push('## Limites');
  finalReportLines.push('- Les tools MCP natifs demeurent indisponibles ; la démonstration repose sur des scripts locaux substitutifs.');
  finalReportLines.push('- Les paramètres d’optimisation et de simulation utilisent des données synthétiques ; une intégration réelle devra affiner ces valeurs.');
  finalReportLines.push('');
  finalReportLines.push('## Pistes immédiates');
  finalReportLines.push('- Intégrer les outils MCP réels lorsque l’orchestrateur sera accessible et comparer les résultats aux journaux simulés.');
  finalReportLines.push('- Étendre les scénarios d’optimisation (gestion multi-ressources, coûts variables) et croiser les sorties enfants avec la simulation.');
  finalReportLines.push('- Automatiser la validation croisée des artefacts (exports, journaux, modules enfants) dans une suite de tests dédiée.');

  await writeFile(join(reportsDir, 'final_report.md'), `${finalReportLines.join('\n')}\n`, 'utf8');

  const toolCallsMdLines = [];
  toolCallsMdLines.push('# Journal des appels MCP simulés');
  toolCallsMdLines.push('');
  toolCallsMdLines.push(`Les entrées exhaustives (inputs exacts, sorties condensées, verdicts, artefacts) sont archivées dans [` +
    `\`logs/graph_tool_calls.json\`](../logs/graph_tool_calls.json) ${childLog.length > 0 ? 'et dans [`logs/children_orchestration_log.json`](../logs/children_orchestration_log.json).' : '.'}`);
  toolCallsMdLines.push('');
  toolCallsMdLines.push('## Opérations de graphe');
  toolCallsMdLines.push('');
  toolCallsMdLines.push('| Tool | Verdict | Résumé | Artefacts |');
  toolCallsMdLines.push('| --- | --- | --- | --- |');
  for (const entry of toolCalls) {
    const artefacts = entry.artefacts?.length > 0 ? entry.artefacts.join('<br>') : '—';
    toolCallsMdLines.push(`| ${escapeMarkdownPipes(entry.tool)} | ${escapeMarkdownPipes(entry.verdict)} | ${escapeMarkdownPipes(entry.summary ?? '')} | ${escapeMarkdownPipes(artefacts)} |`);
  }

  if (childLog.length > 0) {
    toolCallsMdLines.push('');
    toolCallsMdLines.push('## Orchestration d’enfants');
    toolCallsMdLines.push('');
    toolCallsMdLines.push('| Tool | Verdict | Résumé | Artefacts |');
    toolCallsMdLines.push('| --- | --- | --- | --- |');
    for (const entry of childLog) {
      const artefacts = entry.artefacts?.length > 0 ? entry.artefacts.join('<br>') : '—';
      let summary = entry.output?.message ?? entry.summary ?? '';
      if (!summary) {
        switch (entry.tool) {
          case 'plan_fanout': {
            const count = entry.output?.assignedChildren?.length ?? 0;
            summary = `${count} enfant${count > 1 ? 's' : ''} préparé${count > 1 ? 's' : ''}`;
            break;
          }
          case 'child_create': {
            summary = `Environnement initialisé pour ${entry.input?.childId ?? 'N/A'}`;
            if (entry.output?.workdir) {
              summary += ` → ${entry.output.workdir}`;
            }
            break;
          }
          case 'child_send': {
            summary = `Brief transmis à ${entry.input?.childId ?? 'N/A'}`;
            break;
          }
          case 'child_status': {
            const state = entry.output?.state ?? 'inconnu';
            summary = `État ${state}`;
            if (entry.output?.lastLog) {
              summary += ` — ${entry.output.lastLog}`;
            }
            break;
          }
          case 'child_collect': {
            const artefactCount = Object.keys(entry.output?.artefacts ?? {}).length;
            summary = `Artefacts collectés (${artefactCount})`;
            break;
          }
          case 'plan_join': {
            const completed = entry.output?.completed?.length ?? 0;
            summary = `${completed} enfant${completed > 1 ? 's' : ''} synchronisé${completed > 1 ? 's' : ''}`;
            break;
          }
          case 'plan_reduce': {
            summary = `Fusion enregistrée dans ${entry.output?.mergedReport ?? 'N/A'}`;
            break;
          }
          default: {
            summary = entry.output?.status
              ? `${entry.output.status}${entry.output.details ? ` — ${entry.output.details}` : ''}`
              : '';
          }
        }
      }
      toolCallsMdLines.push(`| ${escapeMarkdownPipes(entry.tool)} | ${escapeMarkdownPipes(entry.verdict)} | ${escapeMarkdownPipes(summary)} | ${escapeMarkdownPipes(artefacts)} |`);
    }
  }

  await writeFile(join(reportsDir, 'tool_calls.md'), `${toolCallsMdLines.join('\n')}\n`, 'utf8');

  const indexLines = [];
  indexLines.push('# Index des rapports');
  indexLines.push('');
  indexLines.push('- [README](README.md)');
  indexLines.push('- [Tools Inventory](reports/tools_inventory.json)');
  indexLines.push('- [Graph Overview](reports/graph_overview.md)');
  indexLines.push('- [Graph Algorithms](reports/graph_algorithms.md)');
  indexLines.push('- [Scheduling Results](reports/scheduling_results.md)');
  indexLines.push('- [Tool Calls](reports/tool_calls.md)');
  indexLines.push('- [Children Fanout](reports/children_fanout.md)');
  indexLines.push('- [Visuals](reports/visuals.md)');
  indexLines.push('- [Final Report](reports/final_report.md)');
  indexLines.push('- [Simulation Events](logs/simulation_events.json)');

  await writeFile(join(workspaceDir, 'REPORT_INDEX.md'), `${indexLines.join('\n')}\n`, 'utf8');
}

main().catch((error) => {
  console.error('Graph analysis script failed:', error);
  process.exit(1);
});
