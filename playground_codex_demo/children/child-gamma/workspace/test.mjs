#!/usr/bin/env node
/**
 * Test basique pour valider la transformation child-gamma.
 * Il charge l'entrée d'exemple, exécute `transform` et vérifie le résultat.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import transform from './module.mjs';

const __filename = fileURLToPath(import.meta.url);
const dir = dirname(__filename);
const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8'));
const expected = JSON.parse(await readFile(join(dir, 'expected_output.json'), 'utf8'));
const actual = transform(input);
assert.deepStrictEqual(actual, expected);
console.log('Test OK pour child-gamma');
