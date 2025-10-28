# Validation Build Automation

Before launching the end-to-end scenarios, the checklist requires compiling the
project with the exact sequence `NODE_ENV=development npm ci --include=dev &&
npm run build`. The build helper encapsulates this requirement and records a
complete log under `validation_run/logs/` so auditors can confirm the step was
performed.

## CLI entry point

Invoke the automation through npm:

```bash
npm run validation:build
```

The script performs the following actions:

1. Ensures the canonical `validation_run/` layout exists and resolves the build
   log path (defaults to `validation_run/logs/build.log`).
2. Executes `npm ci --include=dev` with `NODE_ENV=development` to guarantee a
   clean dependency tree matching the lockfile.
3. Executes `npm run build` from the project root, ensuring the TypeScript
   sources are transpiled before the MCP server is started.
4. Streams the standard output and error of each command to the build log,
   annotating timestamps, exit codes, and durations.
5. Exits with a non-zero status if either command fails so the operator can
   remediate before proceeding with the validation runs.

## Programmatic usage

Use `runValidationBuild(options)` to embed the behaviour in other workflows.
Key options include:

- `root`: override the validation layout root (defaults to `./validation_run`).
- `npmExecutable`: point to a custom npm binary when running in a sandboxed
  environment.
- `logFileName`: change the log filename under `validation_run/logs/`.
- `runner`: inject a custom command runner (e.g. for testing or dry runs).

The helper returns a structured `ValidationBuildResult` containing the log file
path, per-command execution details (`durationMs`, `exitCode`, `stdout`,
`stderr`), and a `success` boolean.

Because the implementation is idempotent, it is safe to invoke `runValidationBuild`
multiple times: the directory structure is preserved and the log is appended with
new entries, providing a full audit trail of attempted builds.
