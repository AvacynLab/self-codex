#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatCoordinate, parseCoordinate, scanForDeadExports } from "../src/quality/deadCode.js";

interface AllowlistFile {
  readonly exports?: Array<string>;
}

interface CliOptions {
  readonly projectRoot: string;
  readonly tsconfigPath?: string;
  readonly allowlistPath?: string;
  readonly format: "text" | "json";
}

/** Parses CLI arguments into a structured options object. */
function parseArguments(argv: Array<string>): CliOptions {
  let projectRoot = process.cwd();
  let tsconfigPath: string | undefined;
  let allowlistPath: string | undefined;
  let format: "text" | "json" = "text";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--project":
        projectRoot = resolve(assertValue(argv[++index], token));
        break;
      case "--tsconfig":
        tsconfigPath = resolve(assertValue(argv[++index], token));
        break;
      case "--allowlist":
        allowlistPath = resolve(assertValue(argv[++index], token));
        break;
      case "--format":
        format = validateFormat(assertValue(argv[++index], token));
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return { projectRoot, tsconfigPath, allowlistPath, format };
}

/** Ensures option arguments are present and surfaces a meaningful error. */
function assertValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Validates the requested output format. */
function validateFormat(value: string): "text" | "json" {
  if (value === "text" || value === "json") {
    return value;
  }
  throw new Error(`Unsupported format: ${value}`);
}

/** Prints a short usage banner covering the available CLI options. */
function printUsage(): void {
  // eslint-disable-next-line no-console -- CLI entrypoint meant to write to stdout.
  console.log(`Usage: find-dead-exports [options]\n\n` +
    "Options:\n" +
    "  --project <path>     Root folder used to resolve tsconfig and coordinates.\n" +
    "  --tsconfig <path>    Path to a custom tsconfig.json file.\n" +
    "  --allowlist <path>   JSON file containing export coordinates to ignore.\n" +
    "  --format <text|json> Output mode (defaults to text).\n" +
    "  --help               Display this message.\n");
}

/** Loads allowlisted coordinates from disk when available. */
function loadAllowlist(allowlistPath: string | undefined): ReadonlyArray<string> {
  if (!allowlistPath) {
    return [];
  }
  if (!existsSync(allowlistPath)) {
    return [];
  }
  const raw = readFileSync(allowlistPath, "utf8");
  const parsed = JSON.parse(raw) as AllowlistFile;
  if (!parsed.exports) {
    return [];
  }
  return parsed.exports.map((entry) => parseCoordinate(entry)).map((entry) => formatCoordinate(entry.file, entry.exportName));
}

function main(argv: Array<string>): void {
  const options = parseArguments(argv);
  const allowlistEntries = loadAllowlist(options.allowlistPath ?? resolve(options.projectRoot, "config/dead-code-allowlist.json"));
  const result = scanForDeadExports({
    projectRoot: options.projectRoot,
    tsconfigPath: options.tsconfigPath,
    allowlist: allowlistEntries,
  });

  if (options.format === "json") {
    // eslint-disable-next-line no-console -- CLI entrypoint meant to write to stdout.
    console.log(JSON.stringify(result, null, 2));
  } else if (result.deadExports.length === 0) {
    // eslint-disable-next-line no-console -- CLI entrypoint meant to write to stdout.
    console.log(`✅ No dead exports detected across ${result.totalExports} exports.`);
  } else {
    for (const entry of result.deadExports) {
      // eslint-disable-next-line no-console -- CLI entrypoint meant to write to stdout.
      console.error(
        `Dead export ${formatCoordinate(entry.file, entry.exportName)} (${entry.kind}) defined at ${entry.definition.file}:${entry.definition.line}:${entry.definition.character}`,
      );
    }
  }

  if (result.deadExports.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console -- CLI entrypoint meant to write to stderr.
  console.error(message);
  process.exitCode = 1;
}
