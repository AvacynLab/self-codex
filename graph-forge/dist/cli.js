import { readFile } from "node:fs/promises";
import { compileSource } from "./compiler.js";
import { criticalPath } from "./algorithms/criticalPath.js";
import { shortestPath } from "./algorithms/dijkstra.js";
import { tarjanScc } from "./algorithms/tarjan.js";
async function main(argv) {
    if (argv.length === 0) {
        printUsage();
        process.exit(1);
    }
    const options = parseArgs(argv);
    const contents = await readFile(options.file, "utf8");
    const compiled = compileSource(contents);
    const tasks = [];
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
        const result = handler({ args: task.args, weightKey: options.weightKey, compiledGraph: compiled });
        return { name: task.name, source: task.source, result };
    });
    if (options.format === "json") {
        console.log(JSON.stringify({
            file: options.file,
            analyses: reports
        }, null, 2));
        return;
    }
    for (const report of reports) {
        console.log(`# ${report.name} (${report.source})`);
        formatTextReport(report.name, report.result);
        console.log("");
    }
}
const analysisHandlers = {
    shortestPath: ({ args, weightKey, compiledGraph }) => {
        if (args.length < 2) {
            throw new Error("shortestPath requires <start> and <goal>");
        }
        const [start, goal] = args;
        return shortestPath(compiledGraph.graph, start, goal, { weightAttribute: weightKey });
    },
    criticalPath: ({ weightKey, compiledGraph }) => {
        return criticalPath(compiledGraph.graph, { weightAttribute: weightKey });
    },
    stronglyConnected: ({ compiledGraph }) => {
        return tarjanScc(compiledGraph.graph);
    }
};
function formatTextReport(name, payload) {
    switch (name) {
        case "shortestPath":
            formatShortestPath(payload);
            break;
        case "criticalPath":
            formatCriticalPath(payload);
            break;
        case "stronglyConnected":
            formatScc(payload);
            break;
        default:
            console.log(JSON.stringify(payload, null, 2));
    }
}
function formatShortestPath(result) {
    console.log(`Distance: ${result.distance}`);
    console.log(`Path: ${result.path.join(" -> ")}`);
    console.log(`Visited order: ${result.visitedOrder.join(", ")}`);
}
function formatCriticalPath(result) {
    console.log(`Length: ${result.length}`);
    console.log(`Path: ${result.path.join(" -> ")}`);
    console.log("Schedule:");
    for (const entry of result.schedule) {
        console.log(`  ${entry.node}: start=${entry.start}, finish=${entry.finish}`);
    }
}
function formatScc(result) {
    console.log("Strongly connected components:");
    result.forEach((component, index) => {
        console.log(`  ${index + 1}. ${component.join(", ")}`);
    });
}
function parseArgs(argv) {
    const [file, ...rest] = argv;
    if (!file || file.startsWith("--")) {
        throw new Error("First positional argument must be the path to a .gf file");
    }
    const analyses = [];
    let format = "text";
    let weightKey;
    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        switch (token) {
            case "--analysis": {
                const name = rest[++i];
                if (!name) {
                    throw new Error("--analysis expects a name");
                }
                const args = [];
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
    return { file, format, analyses, weightKey };
}
function coerceToString(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}
function printUsage() {
    console.log("Usage: cli <file.gf> [--analysis name arg1 arg2 ...] [--format json|text] [--weight-key attr]\n");
    console.log("Examples:");
    console.log("  cli pipeline.gf");
    console.log("  cli pipeline.gf --analysis shortestPath Ingest Store");
    console.log("  cli pipeline.gf --analysis criticalPath --format json");
}
if (import.meta.main) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
