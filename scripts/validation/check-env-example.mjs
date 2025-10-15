#!/usr/bin/env node
/**
 * Validation script ensuring `.env.example` documents every environment
 * variable consumed by the orchestrator. The helper parses the file, compares
 * the discovered keys against the authoritative list stored under
 * `config/env/expected-keys.json` and emits actionable diagnostics when
 * something drifts out of sync.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE = resolve(ROOT_DIR, ".env.example");
const EXPECTED_KEYS_FILE = resolve(ROOT_DIR, "config", "env", "expected-keys.json");

/** Parses `.env.example` while ignoring comments and blank lines. */
async function loadEnvKeys() {
  const file = await readFile(ENV_FILE, "utf8");
  const keys = new Set();
  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [name] = trimmed.split("=", 1);
    if (name) {
      keys.add(name.trim());
    }
  }
  return { keys, raw: file };
}

/** Loads the JSON manifest describing mandatory keys and prefixes. */
async function loadExpectations() {
  const raw = await readFile(EXPECTED_KEYS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const required = Array.isArray(parsed.required) ? parsed.required : [];
  const prefixes = Array.isArray(parsed.prefixes) ? parsed.prefixes : [];
  return { required, prefixes };
}

async function main() {
  try {
    const [{ keys, raw }, expectations] = await Promise.all([loadEnvKeys(), loadExpectations()]);

    const missing = expectations.required.filter((name) => !keys.has(name));
    const missingPrefixes = expectations.prefixes.filter((prefix) => !raw.includes(prefix));

    if (missing.length > 0 || missingPrefixes.length > 0) {
      if (missing.length > 0) {
        console.error("❌ .env.example is missing required keys:");
        for (const key of missing) {
          console.error(`   - ${key}`);
        }
      }
      if (missingPrefixes.length > 0) {
        console.error("❌ .env.example does not mention required prefixes:");
        for (const prefix of missingPrefixes) {
          console.error(`   - ${prefix}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    console.log("✅ .env.example is up-to-date with the expected environment keys.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Failed to validate .env.example:", message);
    process.exitCode = 1;
  }
}

void main();
