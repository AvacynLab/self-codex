# Validation Runtime Preparation

The validation checklist requires a reproducible runtime environment before executing
any end-to-end scenario. The utilities introduced in this change automate the
following activities:

- Ensuring the canonical `validation_run/` layout exists.
- Creating the optional `children/` workspace used by the MCP HTTP adapter.
- Validating the Search/Unstructured environment variables for structural issues.
- Probing the MCP server health endpoint, the SearxNG API, and the Unstructured
  ingestion service.

## CLI entry point

Run the helper through the dedicated npm script:

```bash
npm run validation:runtime
```

The script performs these steps in order:

1. Calls `ensureValidationRuntime` to materialise the directory layout and prints
   the recommended MCP environment variables.
2. Executes `validateSearchEnvironment` against `process.env` and surfaces missing
   keys, invalid numeric values, or boolean toggles that should be set to `true`.
3. Verifies the MCP HTTP `/health` endpoint using the configured
   `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`, and `MCP_HTTP_TOKEN`.
4. Probes SearxNG via the configured `SEARCH_SEARX_BASE_URL` and
   `SEARCH_SEARX_API_PATH`, issuing a harmless JSON query.
5. Probes the Unstructured service through its `/health` endpoint when
   `UNSTRUCTURED_BASE_URL` is defined.

The command exits with a non-zero status when any mandatory check fails so that
operators can fix the configuration before proceeding with the validation runs.

## Programmatic usage

- `ensureValidationRuntime(options)` returns the resolved layout and recommended
  MCP environment variables. Set `createChildrenDir: true` to materialise the
  `children/` directory alongside the validation root.
- `validateSearchEnvironment(env)` analyses an environment dictionary and
  returns structured feedback (`missingKeys`, `invalidNumericKeys`, `expectedTrueKeys`).
- `verifyHttpHealth(url, options)` sends an authenticated GET request with an
  optional timeout and captures the status code and response snippet.
- `probeSearx(baseUrl, apiPath, options)` issues a JSON search query to the
  SearxNG API and reports whether the probe succeeded.
- `probeUnstructured(baseUrl, options)` requests the `/health` endpoint of an
  Unstructured deployment.

Each helper is fully idempotent, making them safe to invoke before every
validation scenario as part of the preparation checklist.
