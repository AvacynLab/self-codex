import { expect } from "chai";

import {
  ArtifactReadOutputSchema,
  ArtifactWriteInputSchema,
  ArtifactWriteOutputSchema,
  IntentRouteInputSchema,
  IntentRouteOutputSchema,
  IntentRouteRecommendationSchema,
  PlanCompileExecuteInputSchemaFacade,
  PlanCompileExecuteOutputSchema,
  TOOL_HELP_CATEGORIES,
  ToolsHelpInputSchema,
  ToolsHelpOutputSchema,
  type ArtifactReadOutput,
  type ArtifactWriteInput,
  type ArtifactWriteOutput,
  type IntentRouteInput,
  type IntentRouteOutput,
  type IntentRouteRecommendation,
  type PlanCompileExecuteFacadeInput,
  type PlanCompileExecuteFacadeOutput,
  type ToolsHelpInput,
  type ToolsHelpOutput,
} from "../../src/rpc/schemas.js";

/**
 * Round-trip tests ensuring representative façade payloads stay in sync with
 * the centralised Zod registry. The goal is to guard against accidental schema
 * drift when façade implementations evolve in isolation.
 */
describe("rpc schemas roundtrip", () => {
  it("validates intent_route payloads", () => {
    const input: IntentRouteInput = {
      natural_language_goal: "Analyser un graphe complexe",
      metadata: { trace_id: "trace-001" },
      idempotency_key: "intent-route-123",
    };
    const parsedInput = IntentRouteInputSchema.parse(input);
    expect(parsedInput).to.deep.equal(input);

    const recommendation: IntentRouteRecommendation = IntentRouteRecommendationSchema.parse({
      tool: "graph_apply_change_set",
      score: 0.95,
      rationale: "l'intention évoque explicitement un patch de graphe",
      estimated_budget: { time_ms: 7_000, tool_calls: 1 },
    });

    const output: IntentRouteOutput = {
      ok: true,
      summary: "1 façade recommandée",
      details: {
        idempotency_key: "intent-route-123",
        recommendations: [recommendation],
        diagnostics: [
          { label: "graph_mutation", tool: "graph_apply_change_set", matched: true },
          { label: "fallback", tool: "tools_help", matched: false },
        ],
        metadata: { request_id: "req-001" },
      },
    };
    const parsedOutput = IntentRouteOutputSchema.parse(output);
    expect(parsedOutput).to.deep.equal(output);
  });

  it("validates tools_help payloads", () => {
    const input: ToolsHelpInput = {
      mode: "basic",
      pack: "basic",
      include_hidden: false,
      categories: [TOOL_HELP_CATEGORIES[0]],
      tags: ["facade", "ops"],
      search: "graph",
      limit: 3,
      idempotency_key: "tools-help-456",
      metadata: { actor: "integration-test" },
    };
    const parsedInput = ToolsHelpInputSchema.parse(input);
    expect(parsedInput).to.deep.equal(input);

    const output: ToolsHelpOutput = {
      ok: true,
      summary: "2 outils trouvés",
      details: {
        idempotency_key: "tools-help-456",
        mode: "basic",
        pack: "basic",
        include_hidden: false,
        total: 2,
        returned: 2,
        filters: {
          categories: [TOOL_HELP_CATEGORIES[0]],
          tags: ["facade", "ops"],
          search: "graph",
          limit: 3,
        },
        tools: [
          {
            name: "graph_apply_change_set",
            title: "Appliquer un change-set",
            description: "Applique un patch RFC 6902 au graphe courant.",
            category: "graph",
            tags: ["facade", "ops"],
            budgets: { time_ms: 7_000, tool_calls: 1, bytes_out: 24_576 },
            example: { changes: [{ op: "replace", path: ["nodes", "alpha"], value: {} }] },
            common_errors: ["invalid change-set"],
          },
          {
            name: "tools_help",
            title: "Guide des outils",
            description: "Expose la documentation des façades disponibles.",
            category: "admin",
            tags: ["facade", "authoring"],
            budgets: { time_ms: 1_000, tool_calls: 1, bytes_out: 16_384 },
          },
        ],
        metadata: { trace_id: "trace-002" },
      },
    };
    const parsedOutput = ToolsHelpOutputSchema.parse(output);
    expect(parsedOutput).to.deep.equal(output);
  });

  it("validates plan_compile_execute and artifact payloads", () => {
    const planInput: PlanCompileExecuteFacadeInput = {
      plan: "{\"id\":\"plan-01\",\"tasks\":[{\"id\":\"prepare\",\"tool\":\"artifact_write\"}]}",
      dry_run: true,
      idempotency_key: "plan-compile-789",
      run_id: "run-42",
    };
    const parsedPlanInput = PlanCompileExecuteInputSchemaFacade.parse(planInput);
    expect(parsedPlanInput).to.deep.equal(planInput);

    const planOutput: PlanCompileExecuteFacadeOutput = {
      ok: true,
      summary: "plan compilé",
      details: {
        idempotency_key: "plan-compile-789",
        run_id: "run-42",
        plan_id: "plan-01",
        plan_version: null,
        dry_run: true,
        registered: true,
        idempotent: false,
        plan_hash: "f".repeat(64),
        stats: {
          total_tasks: 1,
          phases: 1,
          parallel_phases: 1,
          critical_path_length: 1,
          estimated_duration_ms: 1500,
          slacky_tasks: 0,
        },
        schedule: {
          critical_path: ["prepare"],
          phases: [
            {
              index: 0,
              earliest_start_ms: 0,
              tasks: [
                { id: "prepare", name: "prepare", slack_ms: 0, estimated_duration_ms: 1500 },
              ],
            },
          ],
        },
      },
    };
    const parsedPlanOutput = PlanCompileExecuteOutputSchema.parse(planOutput);
    expect(parsedPlanOutput).to.deep.equal(planOutput);

    const artifactInput: ArtifactWriteInput = {
      child_id: "child-123",
      path: "outputs/report.json",
      content: "{}",
      encoding: "utf8",
      mime_type: "application/json",
      idempotency_key: "artifact-abc",
      metadata: { correlation: "corr-1" },
    };
    const parsedArtifactInput = ArtifactWriteInputSchema.parse(artifactInput);
    expect(parsedArtifactInput).to.deep.equal(artifactInput);

    const artifactOutput: ArtifactWriteOutput = {
      ok: true,
      summary: "artefact écrit",
      details: {
        idempotency_key: "artifact-abc",
        child_id: "child-123",
        path: "outputs/report.json",
        metadata: { correlation: "corr-1" },
        bytes_written: 2,
        size: 2,
        mime_type: "application/json",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        idempotent: false,
      },
    };
    const parsedArtifactOutput = ArtifactWriteOutputSchema.parse(artifactOutput);
    expect(parsedArtifactOutput).to.deep.equal(artifactOutput);

    const artifactRead: ArtifactReadOutput = {
      ok: true,
      summary: "artefact récupéré",
      details: {
        idempotency_key: "artifact-abc",
        child_id: "child-123",
        path: "outputs/report.json",
        format: "text",
        bytes_returned: 2,
        size: 2,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        truncated: false,
        content: "{}",
        metadata: { correlation: "corr-1" },
      },
    };
    const parsedArtifactRead = ArtifactReadOutputSchema.parse(artifactRead);
    expect(parsedArtifactRead).to.deep.equal(artifactRead);
  });
});
