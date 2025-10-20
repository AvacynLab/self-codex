/**
 * Shared declarations for the loose globals that our Node.js maintenance and
 * validation scripts expose during their dry-run modes.  These definitions let
 * the TypeScript test suites interact with the captured side effects without
 * resorting to `any` casts while documenting the shape of each artefact.
 */

interface ScriptCommandRecord {
  /** Command executed by the helper (usually `npm`). */
  command: string;
  /** Arguments passed to the command in order. */
  args: string[];
  /** Whether stdout/stderr were captured for inspection. */
  captureOutput?: boolean;
  /** Node options automatically injected by the scripts. */
  nodeOptions?: string;
}

interface ScriptEnvironmentSnapshot {
  rawHttpEnable: string;
  httpEnable: boolean;
  httpHost: string;
  httpPort: string;
  httpPath: string;
  httpJson: string;
  httpStateless: string;
  httpToken: string;
  startMcpBg?: boolean;
  fsBridgeDir: string;
}

interface ScriptBackgroundAction extends Record<string, unknown> {
  action: string;
  label?: string;
  nodeOptions?: string;
}

interface ValidationPlanEntry extends Record<string, unknown> {
  type: string;
}

declare global {
  var CODEX_SCRIPT_COMMANDS: ScriptCommandRecord[] | undefined;
  var CODEX_SCRIPT_ENV: ScriptEnvironmentSnapshot | undefined;
  var CODEX_SCRIPT_CONFIG: string | undefined;
  var CODEX_SCRIPT_BACKGROUND: ScriptBackgroundAction[] | undefined;
  var CODEX_SCRIPT_SUMMARY: string | undefined;

  var CODEX_MAINTENANCE_COMMANDS: ScriptCommandRecord[] | undefined;
  var CODEX_MAINTENANCE_ENV: ScriptEnvironmentSnapshot | undefined;
  var CODEX_MAINTENANCE_ACTIONS: ScriptBackgroundAction[] | undefined;
  var CODEX_MAINTENANCE_STATUS: string | undefined;

  var CODEX_VALIDATE_PLAN: ValidationPlanEntry[] | undefined;
}

export {};
