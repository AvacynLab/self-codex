import { describe, it } from "mocha";
import { expect } from "chai";

import {
  __childHandlerInternals,
  DEFAULT_CHILD_RUNTIME,
} from "../../src/server.js";
import { StartInputSchema } from "../../src/rpc/schemas.js";
import {
  ChildSpawnCodexInputSchema,
  ChildBatchCreateInputSchema,
  ChildAttachInputSchema,
  ChildSetRoleInputSchema,
  ChildSetLimitsInputSchema,
  ChildCreateInputSchema,
  ChildStreamInputSchema,
  ChildCancelInputSchema,
} from "../../src/tools/childTools.js";

const {
  normaliseSpawnChildSpecInput,
  buildChildSpawnCodexRequest,
  buildChildBatchCreateRequest,
  buildChildAttachRequest,
  buildChildSetRoleRequest,
  buildChildSetLimitsRequest,
  buildChildStreamRequest,
  buildChildCancelRequest,
  buildChildCreateRequest,
} = __childHandlerInternals;

describe("child handler optional field sanitisation helpers", () => {
  it("drops undefined spawn spec attributes while preserving the default runtime", () => {
    const parsed = StartInputSchema.parse({ job_id: "job-42", children: [{ name: "alpha" }] });
    const spec = parsed.children![0];

    const normalised = normaliseSpawnChildSpecInput(spec);

    expect(normalised).to.deep.equal({ name: "alpha", runtime: DEFAULT_CHILD_RUNTIME });
  });

  it("sanitises child_spawn_codex inputs before forwarding them to the supervisor", () => {
    const spawnInput = ChildSpawnCodexInputSchema.parse({
      prompt: { system: "Tu es un copilote.", user: ["Analyse la requête"] },
      sandbox: { inherit_default_env: true },
    });

    const request = buildChildSpawnCodexRequest(spawnInput);

    expect(request.prompt).to.deep.equal(spawnInput.prompt);
    expect("model_hint" in request).to.equal(false);
    expect("ready_timeout_ms" in request).to.equal(false);
    expect(request.sandbox).to.deep.equal({ inherit_default_env: true });
  });

  it("materialises batch create requests with already-sanitised entries", () => {
    const batchInput = ChildBatchCreateInputSchema.parse({
      entries: [
        {
          prompt: { system: "Salut" },
          limits: { tokens: 128 },
        },
        {
          prompt: { system: "Bonjour", user: ["Utilise les defaults"] },
          sandbox: { env: { FOO: "BAR" } },
        },
      ],
    });

    const request = buildChildBatchCreateRequest(batchInput);

    expect(request.entries).to.have.lengthOf(2);
    expect(request.entries[0]).to.deep.include({ limits: { tokens: 128 } });
    expect("model_hint" in request.entries[0]).to.equal(false);
    expect(request.entries[1].sandbox).to.deep.equal({ env: { FOO: "BAR" } });
  });

  it("omits manifest extras when child_attach callers skip them", () => {
    const attachInput = ChildAttachInputSchema.parse({ child_id: "child-7" });

    const request = buildChildAttachRequest(attachInput);

    expect(request).to.deep.equal({ child_id: "child-7" });
  });

  it("retains manifest extras for child_set_role when callers provide them", () => {
    const setRoleInput = ChildSetRoleInputSchema.parse({
      child_id: "child-8",
      role: "planner",
      manifest_extras: { updated_by: "test" },
    });

    const request = buildChildSetRoleRequest(setRoleInput);

    expect(request).to.deep.equal({
      child_id: "child-8",
      role: "planner",
      manifest_extras: { updated_by: "test" },
    });
  });

  it("only forwards limits in child_set_limits when they are explicitly provided", () => {
    const withoutLimits = ChildSetLimitsInputSchema.parse({ child_id: "child-9" });
    const withLimits = ChildSetLimitsInputSchema.parse({ child_id: "child-9", limits: { tokens: 256 } });

    expect(buildChildSetLimitsRequest(withoutLimits)).to.deep.equal({ child_id: "child-9" });
    expect(buildChildSetLimitsRequest(withLimits)).to.deep.equal({
      child_id: "child-9",
      limits: { tokens: 256 },
    });
  });

  it("drops undefined overrides from child_create requests while keeping booleans intact", () => {
    const createInput = ChildCreateInputSchema.parse({
      child_id: "child-10",
      command: "node",
      args: ["worker.mjs"],
      prompt: { system: "Prépare le terrain", user: ["Démarre"] },
      wait_for_ready: false,
      ready_timeout_ms: 1_500,
      metadata: { project: "demo" },
      manifest_extras: { source: "test" },
    });

    const request = buildChildCreateRequest(createInput);

    expect(request).to.include({
      child_id: "child-10",
      command: "node",
      wait_for_ready: false,
      ready_timeout_ms: 1_500,
    });
    expect(request.args).to.deep.equal(["worker.mjs"]);
    expect(request.prompt).to.deep.equal(createInput.prompt);
    expect(request.manifest_extras).to.deep.equal({ source: "test" });
    expect("initial_payload" in request).to.equal(false);
    expect("idempotency_key" in request).to.equal(false);
  });

  it("sanitises child_stream requests so pagination hints omit undefined fields", () => {
    const streamInput = ChildStreamInputSchema.parse({
      child_id: "child-11",
      limit: 25,
      streams: ["stdout"],
    });

    const request = buildChildStreamRequest(streamInput);

    expect(request).to.deep.equal({ child_id: "child-11", limit: 25, streams: ["stdout"] });
  });

  it("omits signal/timeout placeholders when child_cancel callers skip them", () => {
    const cancelInput = ChildCancelInputSchema.parse({ child_id: "child-12" });
    const cancelWithOverrides = ChildCancelInputSchema.parse({
      child_id: "child-12",
      signal: "SIGTERM",
      timeout_ms: 3_000,
    });

    expect(buildChildCancelRequest(cancelInput)).to.deep.equal({ child_id: "child-12" });
    expect(buildChildCancelRequest(cancelWithOverrides)).to.deep.equal({
      child_id: "child-12",
      signal: "SIGTERM",
      timeout_ms: 3_000,
    });
  });
});
