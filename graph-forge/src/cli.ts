import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { compileSource } from "./compiler.js";
import { criticalPath } from "./algorithms/criticalPath.js";
import { shortestPath } from "./algorithms/dijkstra.js";
import { tarjanScc } from "./algorithms/tarjan.js";
import { AttributeValue } from "./model.js";

interface CliAnalysis {
  readonly name: string;
  readonly args: string[];
  readonly source: "cli" | "defined";
}

interface CliOptions {
  readonly file: string;
  readonly format: "text" | "json";
  readonly analyses: CliAnalysis[];
  readonly weightKey?: string;
}

interface AnalysisInput {
  readonly args: string[];
  readonly compiledGraph: ReturnType<typeof compileSource>;
  readonly weightKey?: string;
}

/**
 * Builds the analysis input object forwarded to individual handlers while
 * omitting the `weightKey` property when it is not explicitly provided.
 *
 * The CLI previously forwarded `{ weightKey: undefined }`, which breaks once
 * `exactOptionalPropertyTypes` is enabled. This helper centralises the
 * sanitisation to make the omission explicit and easily testable.
 */
function buildAnalysisInput(
  task: CliAnalysis,
  compiledGraph: ReturnType<typeof compileSource>,
  weightKey: string | undefined
): AnalysisInput {
  const base = {
    args: task.args,
    compiledGraph
  } as const;
  return weightKey === undefined ? base : { ...base, weightKey };
}

/**
 * Normalises the optional weight attribute passed to the graph algorithms so
 * that we never emit `{ weightAttribute: undefined }` when the CLI flag is not
 * supplied. Returning `undefined` keeps the downstream helper signatures happy
 * under `exactOptionalPropertyTypes`.
 */
function buildWeightAttributeOptions(weightKey: string | undefined):
  | { weightAttribute: string }
  | undefined {
  return weightKey === undefined ? undefined : { weightAttribute: weightKey };
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }

  const options = parseArgs(argv);
  const contents = await readFile(options.file, "utf8");
  const compiled = compileSource(contents);

  const tasks: CliAnalysis[] = [];
  const explicitAnalyses = options.analyses.filter((analysis) => analysis.source === "cli");

  if (explicitAnalyses.length === 0) {
    for (const analysis of compiled.analyses) {
      tasks.push({
        name: analysis.name,
        args: analysis.args.map((arg) => coerceToString(arg.value)),
        source: "defined"
      });
    }
  }

  tasks.push(...explicitAnalyses);

  if (tasks.length === 0) {
    console.log("No analyses requested (CLI or DSL). Nothing to do.");
    return;
  }

  const reports = tasks.map((task) => {
    const handler = analysisHandlers[task.name];
    if (!handler) {
      throw new Error(`Unknown analysis '${task.name}'`);
    }
    const result = handler(buildAnalysisInput(task, compiled, options.weightKey));
    return { name: task.name, source: task.source, result };
  });

  if (options.format === "json") {
    console.log(
      JSON.stringify(
        {
          file: options.file,
          analyses: reports
        },
        null,
        2
      )
    );
    return;
  }

  for (const report of reports) {
    console.log(`# ${report.name} (${report.source})`);
    formatTextReport(report.name, report.result);
    console.log("");
  }
}

type AnalysisHandler = (input: AnalysisInput) => unknown;

const analysisHandlers: Record<string, AnalysisHandler> = {
  shortestPath: ({ args, weightKey, compiledGraph }) => {
    if (args.length < 2) {
      throw new Error("shortestPath requires <start> and <goal>");
    }
    const [start, goal] = args;
    return shortestPath(compiledGraph.graph, start, goal, buildWeightAttributeOptions(weightKey));
  },
  criticalPath: ({ weightKey, compiledGraph }) => {
    return criticalPath(compiledGraph.graph, buildWeightAttributeOptions(weightKey));
  },
  stronglyConnected: ({ compiledGraph }) => {
    return tarjanScc(compiledGraph.graph);
  }
};

function formatTextReport(name: string, payload: unknown): void {
  switch (name) {
    case "shortestPath":
      formatShortestPath(payload as ReturnType<typeof shortestPath>);
      break;
    case "criticalPath":
      formatCriticalPath(payload as ReturnType<typeof criticalPath>);
      break;
    case "stronglyConnected":
      formatScc(payload as ReturnType<typeof tarjanScc>);
      break;
    default:
      console.log(JSON.stringify(payload, null, 2));
  }
}

function formatShortestPath(result: ReturnType<typeof shortestPath>): void {
  console.log(`Distance: ${result.distance}`);
  console.log(`Path: ${result.path.join(" -> ")}`);
  console.log(`Visited order: ${result.visitedOrder.join(", ")}`);
}

function formatCriticalPath(result: ReturnType<typeof criticalPath>): void {
  console.log(`Length: ${result.length}`);
  console.log(`Path: ${result.path.join(" -> ")}`);
  console.log("Schedule:");
  for (const entry of result.schedule) {
    console.log(`  ${entry.node}: start=${entry.start}, finish=${entry.finish}`);
  }
}

function formatScc(result: ReturnType<typeof tarjanScc>): void {
  console.log("Strongly connected components:");
  result.forEach((component, index) => {
    console.log(`  ${index + 1}. ${component.join(", ")}`);
  });
}

function parseArgs(argv: string[]): CliOptions {
  const [file, ...rest] = argv;
  if (!file || file.startsWith("--")) {
    throw new Error("First positional argument must be the path to a .gf file");
  }
  const analyses: CliAnalysis[] = [];
  let format: "text" | "json" = "text";
  let weightKey: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--analysis": {
        const name = rest[++i];
        if (!name) {
          throw new Error("--analysis expects a name");
        }
        const args: string[] = [];
        while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
          args.push(rest[++i]);
        }
        analyses.push({ name, args, source: "cli" });
        break;
      }
      case "--format": {
        const value = rest[++i];
        if (value !== "json" && value !== "text") {
          throw new Error("--format must be 'json' or 'text'");
        }
        format = value;
        break;
      }
      case "--weight-key": {
        const value = rest[++i];
        if (!value) {
          throw new Error("--weight-key expects a value");
        }
        weightKey = value;
        break;
      }
      default:
        throw new Error(`Unknown argument '${token}'`);
    }
  }

  return {
    file,
    format,
    analyses,
    ...(weightKey === undefined ? {} : { weightKey })
  };
}

function coerceToString(value: AttributeValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function printUsage(): void {
  console.log(
    "Usage: cli <file.gf> [--analysis name arg1 arg2 ...] [--format json|text] [--weight-key attr]\n"
  );
  console.log("Examples:");
  console.log("  cli pipeline.gf");
  console.log("  cli pipeline.gf --analysis shortestPath Ingest Store");
  console.log("  cli pipeline.gf --analysis criticalPath --format json");
}

const isCliEntryPoint = (() => {
  const executedFromCli = process.argv[1];
  if (!executedFromCli) {
    return false;
  }

  const thisModulePath = fileURLToPath(import.meta.url);
  return thisModulePath === executedFromCli;
})();

if (isCliEntryPoint) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

/**
 * Exposes internal helpers for the dedicated Node test suite so we can assert
 * optional-field sanitisation without exporting them as part of the runtime
 * API surface.
 */
export const __testing = {
  buildAnalysisInput,
  buildWeightAttributeOptions,
  parseArgs
};
