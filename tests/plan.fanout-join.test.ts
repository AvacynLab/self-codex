import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import { childWorkspacePath } from "../src/paths.js";
import {
  PlanFanoutInputSchema,
  PlanJoinInputSchema,
  PlanReduceInputSchema,
  PlanToolContext,
  handlePlanFanout,
  handlePlanJoin,
  handlePlanReduce,
} from "../src/tools/planTools.js";
import { writeArtifact } from "../src/artifacts.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

function createPlanContext(options: {
  childrenRoot: string;
  supervisor: ChildSupervisor;
  graphState: GraphState;
  logger: StructuredLogger;
  defaultRuntime?: string;
  events: Array<{ kind: string; payload?: unknown }>;
}): PlanToolContext {
  return {
    supervisor: options.supervisor,
    graphState: options.graphState,
    logger: options.logger,
    childrenRoot: options.childrenRoot,
    defaultChildRuntime: options.defaultRuntime ?? "codex",
    emitEvent: (event) => {
      options.events.push({ kind: event.kind, payload: event.payload });
    },
  };
}

describe("plan tools", () => {
  it("launches clones, renders prompts and records the fan-out mapping", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-fanout-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const orchestratorLog = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile: orchestratorLog });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const input = PlanFanoutInputSchema.parse({
        goal: "Collect design options",
        prompt_template: {
          system: "Tu es un clone {{child_name}} specialise en {{specialty}}.",
          user: [
            "Objectif: {{goal}}",
            "Ton identifiant est {{child_index}} dans le run {{run_id}}.",
          ],
        },
        children_spec: {
          list: [
            { name: "alpha", prompt_variables: { specialty: "analyse" } },
            { name: "beta", prompt_variables: { specialty: "implementation" } },
            { name: "gamma", prompt_variables: { specialty: "validation" } },
          ],
        },
        parallelism: 2,
        retry: { max_attempts: 1, delay_ms: 0 },
      });

      const result = await handlePlanFanout(context, input);
      expect(result.child_ids).to.have.length(3);
      expect(events.some((event) => event.kind === "PLAN")).to.equal(true);

      for (const planned of result.planned) {
        expect(planned.prompt_summary).to.include(planned.name);
        expect(planned.prompt_summary).to.include("Objectif");
        expect(planned.prompt_variables.child_index).to.be.a("number");
        const status = supervisor.status(planned.child_id);
        expect(status.runtime.lifecycle).to.equal("running");
      }

      // Double-check that each child workspace contains the expected manifest, log
      // and outbox directories before seeding artifacts used later in the test.
      for (const childId of result.child_ids) {
        const manifestFile = childWorkspacePath(childrenRoot, childId, "manifest.json");
        const logFile = childWorkspacePath(childrenRoot, childId, "logs", "child.log");
        const outboxDir = childWorkspacePath(childrenRoot, childId, "outbox");

        expect((await stat(manifestFile)).isFile()).to.equal(true);
        expect((await stat(logFile)).isFile()).to.equal(true);
        expect((await stat(outboxDir)).isDirectory()).to.equal(true);

        await writeArtifact({
          childrenRoot,
          childId,
          relativePath: `bootstrap/${childId}.txt`,
          data: `bootstrap:${childId}`,
          mimeType: "text/plain",
        });
      }

      const mappingPath = path.join(childrenRoot, result.run_id, "fanout.json");
      const mappingRaw = await readFile(mappingPath, "utf8");
      const mapping = JSON.parse(mappingRaw);
      expect(mapping.job_id).to.equal(result.job_id);
      expect(mapping.children).to.have.length(3);
      expect(mapping.children[0].prompt_summary).to.be.a("string");

      await logger.flush();
      const logRaw = await readFile(orchestratorLog, "utf8");
      const entries = logRaw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { message: string });
      const messages = entries.map((entry) => entry.message);
      expect(messages).to.include("plan_fanout");
      expect(messages.some((message) => message.startsWith("plan_fanout_"))).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("joins child responses using different policies and aggregates outputs", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-join-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const orchestratorLog = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile: orchestratorLog });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const fanout = await handlePlanFanout(
        context,
        PlanFanoutInputSchema.parse({
          goal: "Elaborer une strategie",
          prompt_template: {
            system: "Clone {{child_name}}",
            user: "But: {{goal}}",
          },
          children_spec: { count: 3, name_prefix: "clone" },
        }),
      );

      // Seed a deterministic artifact for each clone so the join planner can
      // return a non-empty manifest for every child.
      for (const childId of fanout.child_ids) {
        await writeArtifact({
          childrenRoot,
          childId,
          relativePath: `bootstrap/${childId}.txt`,
          data: `bootstrap:${childId}`,
          mimeType: "text/plain",
        });
      }

      const joinAll = await handlePlanJoin(
        context,
        PlanJoinInputSchema.parse({
          children: fanout.child_ids,
          join_policy: "all",
          timeout_sec: 2,
        }),
      );
      expect(joinAll.satisfied, JSON.stringify(joinAll)).to.equal(true);
      expect(joinAll.success_count).to.equal(3);
      for (const entry of joinAll.results) {
        expect(entry.status).to.equal("success");
        expect(entry.summary).to.be.a("string");
        expect(
          entry.artifacts.some((artifact) => artifact.path.startsWith("bootstrap/")),
        ).to.equal(true);
      }
      expect(events.some((event) => event.kind === "STATUS")).to.equal(true);

      // Trigger a new wave of prompts to test the first_success policy ordering.
      await supervisor.send(fanout.child_ids[1], { type: "prompt", content: "priorite" });
      await supervisor.send(fanout.child_ids[0], { type: "prompt", content: "second" });
      await supervisor.send(fanout.child_ids[2], { type: "prompt", content: "troisieme" });

      await supervisor.waitForMessage(
        fanout.child_ids[1],
        (message) => {
          const parsed = message.parsed as { type?: string; content?: string } | null;
          return parsed?.type === "response" && parsed.content === "priorite";
        },
        1000,
      );
      await supervisor.waitForMessage(
        fanout.child_ids[0],
        (message) => {
          const parsed = message.parsed as { type?: string; content?: string } | null;
          return parsed?.type === "response" && parsed.content === "second";
        },
        1000,
      );
      await supervisor.waitForMessage(
        fanout.child_ids[2],
        (message) => {
          const parsed = message.parsed as { type?: string; content?: string } | null;
          return parsed?.type === "response" && parsed.content === "troisieme";
        },
        1000,
      );

      const joinFirst = await handlePlanJoin(
        context,
        PlanJoinInputSchema.parse({
          children: fanout.child_ids,
          join_policy: "first_success",
          timeout_sec: 2,
        }),
      );
      expect(joinFirst.satisfied, JSON.stringify(joinFirst)).to.equal(true);
      expect(joinFirst.winning_child_id).to.be.a("string");
      expect(fanout.child_ids).to.include(joinFirst.winning_child_id);
      const winningRecord = joinFirst.results.find(
        (entry) => entry.child_id === joinFirst.winning_child_id,
      );
      expect(winningRecord?.status).to.equal("success");

      const joinQuorum = await handlePlanJoin(
        context,
        PlanJoinInputSchema.parse({
          children: fanout.child_ids,
          join_policy: "quorum",
          quorum_count: 2,
          timeout_sec: 2,
        }),
      );
      expect(joinQuorum.satisfied).to.equal(true);
      expect(joinQuorum.quorum_threshold).to.equal(2);

      // Prepare artifacts and summaries to test the reduce strategies.
      for (const [index, childId] of fanout.child_ids.entries()) {
        await writeArtifact({
          childrenRoot,
          childId,
          relativePath: `reports/child-${index + 1}.txt`,
          data: `ok:${index + 1}`,
          mimeType: "text/plain",
        });
        const payload = JSON.stringify({ vote: index < 2 ? "A" : "B", idx: index });
        await supervisor.send(childId, { type: "prompt", content: payload });
        await supervisor.waitForMessage(
          childId,
          (message) => {
            const parsed = message.parsed as { type?: string; content?: string } | null;
            return parsed?.type === "response" && parsed.content === payload;
          },
          1000,
        );
      }

      const reduceConcat = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "concat",
        }),
      );
      expect(reduceConcat.aggregate).to.be.a("string");
      expect(reduceConcat.trace.per_child).to.have.length(3);

      const reduceMerge = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "merge_json",
        }),
      );
      expect(reduceMerge.reducer).to.equal("merge_json");
      expect(reduceMerge.aggregate).to.have.property("vote");
      expect(reduceMerge.trace.per_child).to.have.length(3);

      const reduceVote = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "vote",
        }),
      );
      expect(reduceVote.reducer).to.equal("vote");
      expect(reduceVote.trace.details).to.have.property("tally");
      expect(events.filter((event) => event.kind === "AGGREGATE")).to.have.length.greaterThan(0);

      await logger.flush();
      const logRaw = await readFile(orchestratorLog, "utf8");
      const entries = logRaw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { message: string });
      const messages = entries.map((entry) => entry.message);
      expect(messages).to.include("plan_join");
      expect(messages).to.include("plan_join_completed");
      expect(messages).to.include("plan_reduce");
      expect(messages).to.include("plan_reduce_completed");
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
