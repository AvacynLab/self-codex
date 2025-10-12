#!/usr/bin/env node
// But : vérifier rapidement que l'environnement de build possède les prérequis essentiels avant d'exécuter les tests.
// Explications : contrôle la présence de @types/node, du compilateur TypeScript, du loader tsx, du tsconfig racine et du lockfile
// pour garantir un pipeline reproductible. Chaque champ du JSON retourné se lit facilement dans la CI.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Version majeure minimale de Node.js requise par l'orchestrateur. Cette valeur
 * reflète à la fois la documentation et le pipeline CI afin d'émettre un
 * avertissement clair lorsque le runtime est trop ancien.
 */
const MINIMUM_NODE_MAJOR = 20;

/**
 * Décompose `process.version` en composantes numériques major/minor/patch. La
 * fonction préfère renvoyer `null` plutôt que de lancer une exception si le
 * format change (cas des forks ou builds personnalisés).
 */
function parseNodeVersion(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return { major: null, minor: null, patch: null };
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

const nodeVersion = parseNodeVersion(process.version);

const report = {
  node: process.version,
  nodeMajor: nodeVersion.major,
  nodeMinor: nodeVersion.minor,
  nodePatch: nodeVersion.patch,
  nodeSatisfiesMin: typeof nodeVersion.major === "number" && nodeVersion.major >= MINIMUM_NODE_MAJOR,
  hasTypesNode: existsSync(resolve("node_modules/@types/node")),
  hasTSC: existsSync(resolve("node_modules/.bin/tsc")),
  hasTSX: existsSync(resolve("node_modules/.bin/tsx")),
  tsconfig: existsSync(resolve("tsconfig.json")),
  lockfile: existsSync(resolve("package-lock.json")),
};

if (report.nodeSatisfiesMin === false) {
  report.warning = `Node.js ${report.node} détecté — mettre à jour vers >=${MINIMUM_NODE_MAJOR}.x pour rester supporté.`;
}

console.log(JSON.stringify(report, null, 2));
