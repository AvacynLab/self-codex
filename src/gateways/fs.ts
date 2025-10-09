import { writeFile } from "node:fs/promises";

/**
 * Narrow abstraction over the Node.js filesystem API used by orchestrator components.
 *
 * The gateway encapsulates privileged calls so higher-level modules (like the
 * child supervisor) can be audited easily and mocked in tests without reaching
 * for the underlying `node:fs` module directly.
 */
export interface FileSystemGateway {
  /** Persists UTF-8 encoded text at the provided absolute path. */
  writeFileUtf8(path: string, data: string): Promise<void>;
}

/**
 * Default implementation relying on the Node.js promise-based filesystem API.
 *
 * Keeping the implementation minimal allows tests to inject deterministic
 * doubles while production code benefits from the battle-tested builtin.
 */
export const defaultFileSystemGateway: FileSystemGateway = {
  async writeFileUtf8(path: string, data: string): Promise<void> {
    await writeFile(path, data, "utf8");
  },
};
