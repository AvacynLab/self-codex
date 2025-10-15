import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

/**
 * Verifies that only vetted gateway modules perform privileged Node.js operations.
 *
 * Direct imports of sensitive built-ins such as `node:fs` or `node:child_process`
 * can easily bypass the sandboxing guarantees provided by {@link src/paths.ts}
 * or spawn untracked workers. By constraining the surface to curated allow-lists
 * we ensure future contributors route new operations through the existing helpers
 * (or explicitly extend the gateway set after a security review). The assertions
 * keep the lists deterministic to simplify diff reviews and incident response.
 */
describe('gateway hygiene', () => {
  /** Absolute path to the repository root (resolved from the test location). */
  const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** Directory containing the production TypeScript sources to inspect. */
  const SRC_DIR = path.join(PROJECT_ROOT, 'src');

  /**
   * Describes an allow-listed gateway rule for a sensitive Node.js builtin module.
   *
   * Each rule encapsulates the static and dynamic import patterns that should be
   * flagged when encountered outside of the curated allow-list.
   */
  interface GatewayRule {
    /** Human-readable description used in assertion error messages. */
    readonly label: string;
    /** Regular expression matching ESM/CJS `import` or `require` statements. */
    readonly staticPattern: RegExp;
    /** Optional regular expression matching dynamic `import()` expressions. */
    readonly dynamicPattern?: RegExp;
    /** Modules (relative to the project root) authorised to use the builtin. */
    readonly allowList: ReadonlySet<string>;
  }

  /**
   * Gateway rules applied to the source tree. Extend this array whenever a new
   * privileged builtin requires dedicated review and documentation.
   */
  const GATEWAY_RULES: readonly GatewayRule[] = [
    {
      label: 'node:fs access must stay within audited gateways',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?fs(?:\/promises)?['"]/,
      dynamicPattern: /import\(['"](?:node:)?fs(?:\/promises)?['"]\)/,
      allowList: new Set([
        // Sandbox profiles persist launch wrappers and policy manifests on disk.
        'src/children/sandbox.ts',
        // Tool registry stores manifests and reload markers between restarts.
        'src/mcp/registry.ts',
        // Layered memory writes durable vector and KG stores to the filesystem.
        'src/memory/kg.ts',
        'src/memory/vector.ts',
        'src/paths.ts',
        // HTTP readiness probe persists readiness markers in the runs root.
        'src/http/readiness.ts',
        'src/monitor/log.ts',
        'src/logger.ts',
        'src/childRuntime.ts',
        'src/gateways/fs.ts',
        'src/gateways/fsArtifacts.ts',
        'src/server.ts',
        // Orchestrator runtime wires configuration defaults and persists manifests.
        'src/orchestrator/runtime.ts',
        'src/artifacts.ts',
        'src/bridge/fsBridge.ts',
        'src/tools/planTools.ts',
        'src/graph/subgraphExtract.ts',
        // State persistence relies on WAL and snapshot writers for replay.
        'src/state/snapshot.ts',
        'src/state/wal.ts',
        // Graph operation logging persists JSONL audit trails via node:fs.
        'src/graph/oplog.ts',
        // Validation helpers persist run artefacts on disk by design.
        'src/validation/runSetup.ts',
        'src/validation/introspection.ts',
        'src/validation/logs.ts',
        'src/validation/logStimulus.ts',
        // Persistent idempotency caches materialise JSONL ledgers on disk.
        'src/infra/idempotencyStore.file.ts',
        'src/validation/graphForge.ts',
        'src/validation/transactions.ts',
        'src/validation/children.ts',
        'src/validation/plans.ts',
        'src/validation/coordination.ts',
        'src/validation/knowledge.ts',
        'src/validation/robustness.ts',
        'src/validation/performance.ts',
        'src/validation/security.ts',
        'src/validation/finalReport.ts',
      ]),
    },
    {
      label: 'node:http/https access is restricted to the server gateway',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?https?['"]/,
      dynamicPattern: /import\(['"](?:node:)?https?['"]\)/,
      allowList: new Set([
        'src/httpServer.ts',
        'src/monitor/dashboard.ts',
        // HTTP helpers parse request bodies and manage security headers for the HTTP transport.
        'src/http/body.ts',
        'src/http/headers.ts',
      ]),
    },
    {
      // Guard against accidental adoption of lower-level networking primitives
      // that bypass HTTP middlewares. These modules expose raw sockets and can
      // reintroduce outbound connectivity despite the repository mandate of
      // offline execution, therefore every new usage must undergo a manual
      // security review before being added to the allow-list.
      label: 'node:net sockets require an explicit security review',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?net['"]/,
      dynamicPattern: /import\(['"](?:node:)?net['"]\)/,
      allowList: new Set<string>([]),
    },
    {
      // HTTP/2 support is intentionally disabled until we vet the associated
      // flow-control surface. Restricting imports keeps the transport
      // deterministic and aligned with the current MCP expectations.
      label: 'node:http2 usage is disabled pending investigation',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?http2['"]/,
      dynamicPattern: /import\(['"](?:node:)?http2['"]\)/,
      allowList: new Set<string>([]),
    },
    {
      label: 'node:child_process spawning is restricted to child runtime gateway',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?child_process['"]/,
      dynamicPattern: /import\(['"](?:node:)?child_process['"]\)/,
      allowList: new Set([
        'src/childRuntime.ts',
        'src/gateways/childProcess.ts',
      ]),
    },
    {
      // Worker threads can escape the orchestrator sandbox by executing arbitrary
      // JavaScript in-process. We currently do not rely on the API in production
      // code, therefore any import should prompt a dedicated security review
      // before being allow-listed.
      label: 'node:worker_threads usage requires an explicit security review',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?worker_threads['"]/,
      dynamicPattern: /import\(['"](?:node:)?worker_threads['"]\)/,
      allowList: new Set<string>([
        // Graph diff/validate workloads can offload heavy computations to vetted worker threads.
        'src/infra/workerPool.ts',
        'src/infra/graphWorkerThread.ts',
      ]),
    },
    {
      // The `vm` module enables evaluation of user-provided code snippets. While
      // powerful, it also bypasses the curated toolset and undermines deterministic
      // replay of child operations. The guard ensures any future adoption is
      // accompanied by a threat modelling exercise.
      label: 'node:vm evaluation must remain disabled unless reviewed',
      staticPattern: /(?:from\s+['"]|require\(['"])(?:node:)?vm['"]/,
      dynamicPattern: /import\(['"](?:node:)?vm['"]\)/,
      allowList: new Set<string>([]),
    },
  ];

  it('restricts privileged imports to gateway modules', async () => {
    const filesToInspect = await collectTypeScriptFiles(SRC_DIR);
    /** Aggregated list of offenders for each gateway rule. */
    const offendersByRule = new Map<GatewayRule, string[]>(
      GATEWAY_RULES.map((rule) => [rule, []]),
    );

    for (const absolutePath of filesToInspect) {
      const relativePath = path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join('/');
      const source = await readFile(absolutePath, 'utf8');

      for (const rule of GATEWAY_RULES) {
        const usesPrivilegedModule =
          rule.staticPattern.test(source) ||
          (rule.dynamicPattern?.test(source) ?? false);

        if (usesPrivilegedModule && !rule.allowList.has(relativePath)) {
          offendersByRule.get(rule)!.push(relativePath);
        }
      }
    }

    for (const [rule, offenders] of offendersByRule) {
      expect(
        offenders,
        `unexpected privileged imports detected (${rule.label})`,
      ).to.deep.equal([]);
    }
  });

  /**
   * Recursively collects TypeScript source files under the provided directory.
   *
   * `.d.ts` declaration files are ignored because they do not contain runtime
   * imports. Results are sorted to keep the assertion output deterministic.
   */
  async function collectTypeScriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTypeScriptFiles(resolved)));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(resolved);
      }
    }

    files.sort();
    return files;
  }
});
