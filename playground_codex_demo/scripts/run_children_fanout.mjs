#!/usr/bin/env node
/**
 * Script de démonstration pour simuler les outils MCP d'orchestration
 * d'enfants Codex. Il applique les étapes plan_fanout → child_* →
 * plan_join → plan_reduce en générant de véritables artefacts dans le
 * dossier `playground_codex_demo/children`. Chaque étape enregistre
 * l'entrée utilisée, un résultat condensé, un verdict et les artefacts
 * produits afin de respecter les contraintes du scénario utilisateur.
 */

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const workspaceDir = dirname(scriptDir);
const childrenDir = join(workspaceDir, 'children');
const logsDir = join(workspaceDir, 'logs');
const reportsDir = join(workspaceDir, 'reports');

/**
 * Écrit du JSON joliment formaté avec un retour à la ligne final pour
 * conserver une diff git propre.
 */
async function writeJson(targetPath, data) {
  await writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Enregistre la trace d'un pseudo-appel d'outil MCP avec son entrée,
 * une synthèse de résultat, un verdict et, si besoin, les artefacts.
 */
function recordCall(logEntries, { tool, input, output, verdict, artefacts = [] }) {
  logEntries.push({ tool, input, output, verdict, artefacts });
}

/**
 * Crée un petit module JavaScript (ESM) qui implémente la transformation
 * décrite dans la spécification. Chaque module exporte une fonction
 * `transform` et un export par défaut identique pour simplifier l'usage.
 */
function buildModuleSource(spec) {
  switch (spec.id) {
    case 'child-alpha':
      return `/**\n * Trie la liste des tâches par priorité décroissante, puis par date d'échéance\n * croissante. Ajoute un rang calculé pour faciliter le reporting.\n * @param {{ items: Array<{ title: string, priority: number, dueDays: number }> }} input\n * @returns {{ items: Array<{ title: string, priority: number, dueDays: number, rank: number }> }}\n */\nexport function transform(input) {\n  if (!input || !Array.isArray(input.items)) {\n    throw new TypeError('Expected input.items to be an array of task descriptors.');\n  }\n  // Duplique les tâches pour éviter toute mutation du tableau source.\n  const normalised = input.items.map((task) => ({\n    title: String(task.title),\n    priority: Number(task.priority),\n    dueDays: Number(task.dueDays)\n  }));\n  // Tri multi-critères : priorité décroissante puis échéance croissante.\n  normalised.sort((a, b) => {\n    if (b.priority !== a.priority) {\n      return b.priority - a.priority;\n    }\n    return a.dueDays - b.dueDays;\n  });\n  return {\n    items: normalised.map((task, index) => ({\n      ...task,\n      rank: index + 1\n    }))\n  };\n}\n\nexport default transform;\n`;
    case 'child-beta':
      return `/**\n * Filtre les métriques qui ne respectent pas les contraintes de couverture\n * minimale et de durée maximale, puis synthétise les compteurs associés.\n * @param {{ metrics: Array<{ name: string, coverage: number, runtime: number }>, constraints: { minCoverage: number, maxRuntime: number } }} input\n * @returns {{ flagged: Array<{ name: string, coverage: number, runtime: number, issues: string[] }>, summary: { total: number, failingCoverage: number, failingRuntime: number } }}\n */\nexport function transform(input) {\n  if (!input || !Array.isArray(input.metrics)) {\n    throw new TypeError('Expected input.metrics to be an array of metric objects.');\n  }\n  const minCoverage = Number(input.constraints?.minCoverage ?? 0);\n  const maxRuntime = Number(input.constraints?.maxRuntime ?? Number.POSITIVE_INFINITY);\n  const flagged = [];\n  let failingCoverage = 0;\n  let failingRuntime = 0;\n  for (const metric of input.metrics) {\n    const issues = [];\n    const coverage = Number(metric.coverage);\n    const runtime = Number(metric.runtime);\n    if (coverage < minCoverage) {\n      issues.push('coverage');\n      failingCoverage += 1;\n    }\n    if (runtime > maxRuntime) {\n      issues.push('runtime');\n      failingRuntime += 1;\n    }\n    if (issues.length > 0) {\n      flagged.push({\n        name: String(metric.name),\n        coverage,\n        runtime,\n        issues\n      });\n    }\n  }\n  return {\n    flagged,\n    summary: {\n      total: input.metrics.length,\n      failingCoverage,\n      failingRuntime\n    }\n  };\n}\n\nexport default transform;\n`;
    case 'child-gamma':
      return `/**\n * Agrège la durée totale et moyenne par catégorie d'étapes afin d'identifier\n * le groupe le plus coûteux.\n * @param {{ runs: Array<{ stage: string, duration: number }> }} input\n * @returns {{ aggregates: Record<string, { totalDuration: number, meanDuration: number, occurrences: number }>, slowest: { stage: string, meanDuration: number } | null }}\n */\nexport function transform(input) {\n  if (!input || !Array.isArray(input.runs)) {\n    throw new TypeError('Expected input.runs to be an array of stage duration entries.');\n  }\n  const aggregates = new Map();\n  for (const run of input.runs) {\n    const stage = String(run.stage);\n    const duration = Number(run.duration);\n    const current = aggregates.get(stage) ?? { totalDuration: 0, occurrences: 0 };\n    current.totalDuration += duration;\n    current.occurrences += 1;\n    aggregates.set(stage, current);\n  }\n  let slowest = null;\n  for (const [stage, info] of aggregates.entries()) {\n    info.meanDuration = info.totalDuration / info.occurrences;\n    if (!slowest || info.meanDuration > slowest.meanDuration) {\n      slowest = { stage, meanDuration: info.meanDuration };\n    }\n  }\n  const serialised = Object.fromEntries(aggregates.entries());\n  return { aggregates: serialised, slowest };\n}\n\nexport default transform;\n`;
    default:
      throw new Error(`Unknown specification ${spec.id}`);
  }
}

/**
 * Fonctions de référence utilisées pour générer les sorties attendues.
 */
const transformers = {
  'child-alpha': (input) => {
    const clone = input.items.map((task) => ({
      title: String(task.title),
      priority: Number(task.priority),
      dueDays: Number(task.dueDays)
    }));
    clone.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.dueDays - b.dueDays;
    });
    return { items: clone.map((task, index) => ({ ...task, rank: index + 1 })) };
  },
  'child-beta': (input) => {
    const minCoverage = Number(input.constraints.minCoverage);
    const maxRuntime = Number(input.constraints.maxRuntime);
    const flagged = [];
    let failingCoverage = 0;
    let failingRuntime = 0;
    for (const metric of input.metrics) {
      const coverage = Number(metric.coverage);
      const runtime = Number(metric.runtime);
      const issues = [];
      if (coverage < minCoverage) {
        issues.push('coverage');
        failingCoverage += 1;
      }
      if (runtime > maxRuntime) {
        issues.push('runtime');
        failingRuntime += 1;
      }
      if (issues.length > 0) {
        flagged.push({
          name: String(metric.name),
          coverage,
          runtime,
          issues
        });
      }
    }
    return {
      flagged,
      summary: {
        total: input.metrics.length,
        failingCoverage,
        failingRuntime
      }
    };
  },
  'child-gamma': (input) => {
    const aggregates = new Map();
    for (const run of input.runs) {
      const stage = String(run.stage);
      const duration = Number(run.duration);
      const current = aggregates.get(stage) ?? { totalDuration: 0, occurrences: 0 };
      current.totalDuration += duration;
      current.occurrences += 1;
      aggregates.set(stage, current);
    }
    let slowest = null;
    for (const [stage, info] of aggregates.entries()) {
      info.meanDuration = info.totalDuration / info.occurrences;
      if (!slowest || info.meanDuration > slowest.meanDuration) {
        slowest = { stage, meanDuration: info.meanDuration };
      }
    }
    return {
      aggregates: Object.fromEntries(aggregates.entries()),
      slowest
    };
  }
};

const childSpecs = [
  {
    id: 'child-alpha',
    label: 'Tri du backlog CI',
    language: 'JavaScript',
    transformation: 'Trier les tâches par priorité décroissante et échéance croissante en ajoutant un rang.',
    sampleInput: {
      items: [
        { title: 'Stabiliser lint', priority: 2, dueDays: 5 },
        { title: 'Refactor build', priority: 3, dueDays: 7 },
        { title: 'Couverture API', priority: 3, dueDays: 4 },
        { title: 'Optimiser bundle', priority: 1, dueDays: 3 }
      ]
    }
  },
  {
    id: 'child-beta',
    label: 'Filtrage de métriques QA',
    language: 'JavaScript',
    transformation: 'Identifier les métriques qui violent la couverture minimale de 85% ou un runtime supérieur à 12 minutes.',
    sampleInput: {
      constraints: { minCoverage: 85, maxRuntime: 12 },
      metrics: [
        { name: 'ui-regression', coverage: 88, runtime: 11 },
        { name: 'api-contract', coverage: 82, runtime: 13 },
        { name: 'load-tests', coverage: 79, runtime: 10 },
        { name: 'smoke', coverage: 93, runtime: 6 }
      ]
    }
  },
  {
    id: 'child-gamma',
    label: 'Agrégation des durées de stages',
    language: 'JavaScript',
    transformation: "Comparer la durée moyenne par stage (lint/test/build/package) pour repérer le goulet d'étranglement.",
    sampleInput: {
      runs: [
        { stage: 'lint', duration: 2.5 },
        { stage: 'test', duration: 9.1 },
        { stage: 'build', duration: 7.4 },
        { stage: 'test', duration: 8.7 },
        { stage: 'package', duration: 3.2 },
        { stage: 'build', duration: 6.9 }
      ]
    }
  }
];

async function main() {
  await mkdir(childrenDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  const logEntries = [];

  recordCall(logEntries, {
    tool: 'plan_fanout',
    input: {
      template: 'json-transform-module',
      children: childSpecs.map((spec) => ({ id: spec.id, language: spec.language, transformation: spec.transformation }))
    },
    output: {
      assignedChildren: childSpecs.map((spec) => ({ id: spec.id, status: 'prepared' }))
    },
    verdict: 'SIMULATED_OK'
  });

  const collectedOutputs = {};

  for (const spec of childSpecs) {
    const childDir = join(childrenDir, spec.id);
    const workspace = join(childDir, 'workspace');
    const inboxDir = join(childDir, 'inbox');
    const outboxDir = join(childDir, 'outbox');

    await rm(childDir, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outboxDir, { recursive: true });

    recordCall(logEntries, {
      tool: 'child_create',
      input: {
        childId: spec.id,
        tools_allow: ['fs'],
        idleSec: 60,
        totalSec: 300
      },
      output: {
        workdir: relative(workspaceDir, workspace),
        inbox: relative(workspaceDir, inboxDir),
        outbox: relative(workspaceDir, outboxDir)
      },
      verdict: 'SIMULATED_OK'
    });

    const promptPayload = {
      instructions: spec.transformation,
      language: spec.language,
      artefacts: ['module.mjs', 'README.md', 'test.mjs', 'input.json', 'expected_output.json']
    };
    await writeJson(join(inboxDir, 'request.json'), promptPayload);

    recordCall(logEntries, {
      tool: 'child_send',
      input: { childId: spec.id, payload: promptPayload },
      output: { acknowledgement: 'received' },
      verdict: 'SIMULATED_OK'
    });

    const moduleSource = buildModuleSource(spec);
    await writeFile(join(workspace, 'module.mjs'), moduleSource, 'utf8');

    const expected = transformers[spec.id](spec.sampleInput);
    await writeJson(join(workspace, 'input.json'), spec.sampleInput);
    await writeJson(join(workspace, 'expected_output.json'), expected);

    const readmeContent = `# ${spec.label}\n\n` +
      `## Objectif\n` +
      `Ce module transforme un JSON selon l'instruction : **${spec.transformation}**.\n\n` +
      `## Fichiers générés\n` +
      `- \`module.mjs\` — implémentation ES Module documentée.\n` +
      `- \`input.json\` — exemple d'entrée utilisé pour le test.\n` +
      `- \`expected_output.json\` — sortie attendue pour l'exemple.\n` +
      `- \`test.mjs\` — test automatisé à exécuter avec \`node test.mjs\`.\n\n` +
      `## Exécution\n` +
      `\`\`\`bash\nnode test.mjs\n\`\`\`\n`;
    await writeFile(join(childDir, 'README.md'), `${readmeContent}\n`, 'utf8');

    const testSource = `#!/usr/bin/env node\n/**\n * Test basique pour valider la transformation ${spec.id}.\n * Il charge l'entrée d'exemple, exécute \`transform\` et vérifie le résultat.\n */\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\nimport { dirname, join } from 'node:path';\nimport transform from './module.mjs';\n\nconst __filename = fileURLToPath(import.meta.url);\nconst dir = dirname(__filename);\nconst input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8'));\nconst expected = JSON.parse(await readFile(join(dir, 'expected_output.json'), 'utf8'));\nconst actual = transform(input);\nassert.deepStrictEqual(actual, expected);\nconsole.log('Test OK pour ${spec.id}');\n`;
    await writeFile(join(workspace, 'test.mjs'), testSource, 'utf8');

    const { stdout } = await execFileAsync('node', ['test.mjs'], { cwd: workspace });

    recordCall(logEntries, {
      tool: 'child_status',
      input: { childId: spec.id },
      output: { state: 'ready', lastLog: stdout.trim() },
      verdict: 'SIMULATED_OK'
    });

    const outputData = transformers[spec.id](spec.sampleInput);
    collectedOutputs[spec.id] = outputData;
    await writeJson(join(outboxDir, 'output.json'), outputData);
    await writeFile(join(outboxDir, 'STATUS.md'), `# Statut\n\n- Etat : READY\n- Test : ${stdout.trim()}\n`, 'utf8');

    recordCall(logEntries, {
      tool: 'child_collect',
      input: { childId: spec.id },
      output: {
        artefacts: {
          module: relative(workspaceDir, join(workspace, 'module.mjs')),
          test: relative(workspaceDir, join(workspace, 'test.mjs')),
          output: relative(workspaceDir, join(outboxDir, 'output.json'))
        }
      },
      verdict: 'SIMULATED_OK',
      artefacts: [
        relative(workspaceDir, join(workspace, 'module.mjs')),
        relative(workspaceDir, join(workspace, 'test.mjs')),
        relative(workspaceDir, join(outboxDir, 'output.json'))
      ]
    });
  }

  recordCall(logEntries, {
    tool: 'plan_join',
    input: { joinPolicy: 'all', expected: childSpecs.map((spec) => spec.id) },
    output: { completed: Object.keys(collectedOutputs) },
    verdict: 'SIMULATED_OK'
  });

  const merged = {
    timestamp: new Date().toISOString(),
    children: collectedOutputs
  };
  const mergePath = join(reportsDir, 'children_merge.json');
  await writeJson(mergePath, merged);

  recordCall(logEntries, {
    tool: 'plan_reduce',
    input: { reducer: 'merge_json', mergeOrder: childSpecs.map((spec) => spec.id) },
    output: { mergedReport: relative(workspaceDir, mergePath) },
    verdict: 'SIMULATED_OK',
    artefacts: [relative(workspaceDir, mergePath)]
  });

  const logPath = join(logsDir, 'children_orchestration_log.json');
  await writeJson(logPath, logEntries);

  const markdownLines = [];
  markdownLines.push('# Orchestration des enfants Codex');
  markdownLines.push('');
  markdownLines.push('## Résumé des outils simulés');
  markdownLines.push('');
  for (const entry of logEntries) {
    markdownLines.push(`### ${entry.tool}`);
    markdownLines.push('');
    markdownLines.push('- **Input** :');
    markdownLines.push('```json');
    markdownLines.push(JSON.stringify(entry.input, null, 2));
    markdownLines.push('```');
    markdownLines.push('- **Résultat** :');
    markdownLines.push('```json');
    markdownLines.push(JSON.stringify(entry.output, null, 2));
    markdownLines.push('```');
    markdownLines.push(`- **Verdict** : ${entry.verdict}`);
    if (entry.artefacts.length > 0) {
      markdownLines.push(`- **Artefacts** : ${entry.artefacts.map((path) => `\`${path}\``).join(', ')}`);
    }
    markdownLines.push('');
  }
  markdownLines.push('## Synthèse agrégée');
  markdownLines.push('');
  markdownLines.push('| Enfant | Description | Artefact principal |');
  markdownLines.push('| --- | --- | --- |');
  for (const spec of childSpecs) {
    markdownLines.push(`| ${spec.id} | ${spec.transformation} | [output](../children/${spec.id}/outbox/output.json) |`);
  }
  markdownLines.push('');
  markdownLines.push('Le fichier `children_merge.json` propose un agrégat direct des sorties pour faciliter les analyses ultérieures.');

  await writeFile(join(reportsDir, 'children_fanout.md'), `${markdownLines.join('\n')}\n`, 'utf8');
}

main().catch((error) => {
  console.error('Children orchestration simulation failed:', error);
  process.exit(1);
});
