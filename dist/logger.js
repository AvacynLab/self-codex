import { appendFile } from "node:fs/promises";
/**
 * Structured logger that emits JSON lines on stdout and optionally mirrors them
 * to a file. File writes are queued sequentially to guarantee ordering.
 */
export class StructuredLogger {
    logFile;
    writeQueue = Promise.resolve();
    constructor(options = {}) {
        this.logFile = options.logFile ?? undefined;
    }
    info(message, payload) {
        this.log("info", message, payload);
    }
    warn(message, payload) {
        this.log("warn", message, payload);
    }
    error(message, payload) {
        this.log("error", message, payload);
    }
    debug(message, payload) {
        this.log("debug", message, payload);
    }
    log(level, message, payload) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...(payload !== undefined ? { payload } : {})
        };
        const line = `${JSON.stringify(entry)}\n`;
        process.stdout.write(line);
        if (!this.logFile) {
            return;
        }
        this.writeQueue = this.writeQueue
            .then(async () => {
            try {
                await appendFile(this.logFile, line, "utf8");
            }
            catch (err) {
                const errorEntry = {
                    timestamp: new Date().toISOString(),
                    level: "error",
                    message: "log_file_write_failed",
                    payload: err instanceof Error ? { message: err.message } : { error: String(err) }
                };
                process.stderr.write(`${JSON.stringify(errorEntry)}\n`);
            }
        })
            .catch(() => {
            // Errors already reported; reset queue to avoid unhandled rejections.
            this.writeQueue = Promise.resolve();
        });
    }
}
