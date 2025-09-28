import { randomUUID } from "crypto";
const FLAG_WITH_VALUE = new Set([
    "--http-port",
    "--http-host",
    "--http-path",
]);
/**
 * Ensures a provided numeric string can be converted to a positive integer.
 */
function parsePositiveInteger(value, flag) {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
        throw new Error(`La valeur ${value} pour ${flag} doit être un entier positif.`);
    }
    return num;
}
/**
 * Normalises an HTTP path ensuring it is absolute and non-empty.
 */
function normalizeHttpPath(raw) {
    const cleaned = raw.trim();
    if (!cleaned.length) {
        throw new Error("Le chemin HTTP ne peut pas être vide.");
    }
    if (!cleaned.startsWith("/")) {
        return `/${cleaned}`;
    }
    return cleaned;
}
/**
 * Default runtime configuration used before CLI flags are processed.
 */
const DEFAULT_STATE = {
    enableStdio: true,
    httpEnabled: false,
    httpPort: 4000,
    httpHost: "0.0.0.0",
    httpPath: "/mcp",
    httpEnableJson: false,
    httpStateless: false,
};
/**
 * Parses CLI arguments in order to determine how the orchestrator must expose
 * its transports. The function accepts raw `process.argv.slice(2)` content and
 * returns a structured object that can directly be consumed by the runtime.
 */
export function parseOrchestratorRuntimeOptions(argv) {
    const state = { ...DEFAULT_STATE };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            continue;
        }
        const [flag, inlineValue] = arg.split("=", 2);
        const expectsValue = FLAG_WITH_VALUE.has(flag);
        let value = inlineValue;
        if (expectsValue && (value === undefined || value === "")) {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith("--")) {
                throw new Error(`Le flag ${flag} requiert une valeur.`);
            }
            value = next;
            index += 1;
        }
        switch (flag) {
            case "--no-stdio":
                state.enableStdio = false;
                break;
            case "--http-port":
                state.httpPort = parsePositiveInteger(value ?? "", flag);
                state.httpEnabled = true;
                break;
            case "--http-host":
                state.httpHost = (value ?? "").trim();
                if (!state.httpHost.length) {
                    throw new Error("L'hôte HTTP ne peut pas être vide.");
                }
                state.httpEnabled = true;
                break;
            case "--http-path":
                state.httpPath = normalizeHttpPath(value ?? "");
                state.httpEnabled = true;
                break;
            case "--http-json":
                state.httpEnableJson = true;
                state.httpEnabled = true;
                break;
            case "--http-stateless":
                state.httpStateless = true;
                state.httpEnabled = true;
                break;
            case "--http":
                state.httpEnabled = true;
                break;
            default:
                // Ignore unknown flags so the orchestrator remains permissive for
                // future arguments handled elsewhere.
                break;
        }
    }
    return {
        enableStdio: state.enableStdio,
        http: {
            enabled: state.httpEnabled,
            port: state.httpPort,
            host: state.httpHost,
            path: state.httpPath,
            enableJson: state.httpEnableJson,
            stateless: state.httpStateless,
        },
    };
}
/**
 * Generates an identifier suitable for Streamable HTTP sessions. Exposed to
 * keep session generation logic centralised and testable.
 */
export function createHttpSessionId() {
    return randomUUID();
}
