import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChildSupervisor } from "../src/childSupervisor.js";
import type { ChildCollectedOutputs, ChildRuntimeMessage } from "../src/childRuntime.js";
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
import { StigmergyField } from "../src/coord/stigmergy.js";
import type { EventCorrelationHints } from "../src/events/correlation.js";
import { ThoughtGraphCoordinator } from "../src/reasoning/thoughtCoordinator.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const stubbornRunnerPath = resolveFixture(import.meta.url, "./fixtures/stubborn-runner.ts");

const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);
const stubbornRunnerArgs = (...extra: string[]): string[] => runnerArgs(stubbornRunnerPath, ...extra);

interface RecordedEvent {
  kind: string;
  payload?: unknown;
  jobId: string | null;
  childId: string | null;
  correlation: EventCorrelationHints | null;
}

function createPlanContext(options: {
  childrenRoot: string;
  supervisor: ChildSupervisor;
  graphState: GraphState;
  logger: StructuredLogger;
  defaultRuntime?: string;
  events: RecordedEvent[];
  thoughtManager?: ThoughtGraphCoordinator;
}): PlanToolContext {
  const stigmergy = new StigmergyField();
  const thoughtManager = options.thoughtManager
    ?? new ThoughtGraphCoordinator({ graphState: options.graphState, logger: options.logger });
  return {
    supervisor: options.supervisor,
    graphState: options.graphState,
    logger: options.logger,
    childrenRoot: options.childrenRoot,
    defaultChildRuntime: options.defaultRuntime ?? "codex",
    emitEvent: (event) => {
      options.events.push({
        kind: event.kind,
        payload: event.payload,
        jobId: event.jobId ?? null,
        childId: event.childId ?? null,
        correlation: event.correlation ?? null,
      });
    },
    stigmergy,
    thoughtManager,
  };
}

describe("plan tools", () => {
  it("launches clones, renders prompts and records the fan-out mapping", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-fanout-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
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
      expect(result.op_id).to.be.a("string");
      expect(result.op_id).to.match(/^plan_fanout_op_/);
      expect(result.graph_id).to.equal(null);
      expect(result.node_id).to.equal(null);
      expect(result.child_id).to.equal(null);
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

        const manifestRaw = await readFile(manifestFile, "utf8");
        const manifest = JSON.parse(manifestRaw) as {
          metadata?: { run_id?: string; op_id?: string; parent_child_id?: string | null };
        };
        expect(manifest.metadata?.run_id).to.equal(result.run_id);
        expect(manifest.metadata?.op_id).to.equal(result.op_id);
        expect(manifest.metadata?.parent_child_id ?? null).to.equal(null);

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
      expect(mapping.op_id).to.equal(result.op_id);
      expect(mapping.graph_id).to.equal(null);
      expect(mapping.node_id).to.equal(null);
      expect(mapping.child_id).to.equal(null);
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

      const thoughtGraph = graphState.getThoughtGraph(result.job_id);
      expect(thoughtGraph, "thought graph snapshot should exist after fanout").to.not.equal(null);
      const branchNodes = thoughtGraph!.nodes.filter((node) => node.parents.includes(`run:${result.run_id}`));
      expect(branchNodes).to.have.length(result.child_ids.length);
      expect(branchNodes.map((node) => node.id).sort()).to.deep.equal([...result.child_ids].sort());
      expect(branchNodes.every((node) => node.status === "pending" || node.status === "running")).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("propagates provided correlation hints across outputs", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-fanout-hints-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
    });
    const graphState = new GraphState();
    const orchestratorLog = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile: orchestratorLog });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const hints = {
        run_id: "run-hints-001",
        op_id: "plan-fanout-op-hints",
        job_id: "job-hints-777",
        graph_id: "graph-hints-alpha",
        node_id: "node-hints-omega",
        child_id: "parent-child-hints",
      } as const;

      const input = PlanFanoutInputSchema.parse({
        goal: "Coordonner un unique clone",
        prompt_template: {
          system: "Clone {{child_name}} specialise sur {{goal}}",
          user: "Execution corrélée {{run_id}}",
        },
        children_spec: {
          list: [{ name: "unique", prompt_variables: { focus: "hints" } }],
        },
        ...hints,
      });

      const result = await handlePlanFanout(context, input);
      expect(result.run_id).to.equal(hints.run_id);
      expect(result.op_id).to.equal(hints.op_id);
      expect(result.job_id).to.equal(hints.job_id);
      expect(result.graph_id).to.equal(hints.graph_id);
      expect(result.node_id).to.equal(hints.node_id);
      expect(result.child_id).to.equal(hints.child_id);

      const planEvent = events.find((event) => event.kind === "PLAN");
      expect(planEvent?.payload).to.deep.include({
        run_id: hints.run_id,
        op_id: hints.op_id,
        job_id: hints.job_id,
        graph_id: hints.graph_id,
        node_id: hints.node_id,
        child_id: hints.child_id,
      });

      const mappingPath = path.join(childrenRoot, result.run_id, "fanout.json");
      const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
      expect(mapping.op_id).to.equal(hints.op_id);
      expect(mapping.graph_id).to.equal(hints.graph_id);
      expect(mapping.node_id).to.equal(hints.node_id);
      expect(mapping.child_id).to.equal(hints.child_id);

      const manifestPath = childWorkspacePath(childrenRoot, result.child_ids[0]!, "manifest.json");
      const manifestRaw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw) as {
        metadata?: { run_id?: string; op_id?: string; parent_child_id?: string | null };
      };
      expect(manifest.metadata?.run_id).to.equal(hints.run_id);
      expect(manifest.metadata?.op_id).to.equal(hints.op_id);
      expect(manifest.metadata?.parent_child_id).to.equal(hints.child_id);

      await logger.flush();
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("emits correlated STATUS and AGGREGATE events when hints are supplied", async () => {
    const events: RecordedEvent[] = [];
    const supervisor = {
      collect: async (childId: string): Promise<ChildCollectedOutputs> => {
        const message: ChildRuntimeMessage<{ type: string; content: string }> = {
          raw: JSON.stringify({ type: "response", content: `${childId}:ok` }),
          parsed: { type: "response", content: `${childId}:ok` },
          stream: "stdout",
          receivedAt: Date.now(),
          sequence: 1,
        };
        return {
          childId,
          manifestPath: path.join(tmpdir(), `${childId}.manifest.json`),
          logPath: path.join(tmpdir(), `${childId}.child.log`),
          messages: [message],
          artifacts: [],
        };
      },
      waitForMessage: async () => {
        throw new Error("waitForMessage should not be invoked when outputs are already terminal");
      },
    } as unknown as ChildSupervisor;

    const logger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      flush: async () => {},
    } as unknown as StructuredLogger;

    const context = createPlanContext({
      childrenRoot: tmpdir(),
      supervisor,
      graphState: new GraphState(),
      logger,
      events,
    });

    const hints = {
      run_id: "plan-join-reduce-run",
      op_id: "plan-join-reduce-op",
      job_id: "plan-join-reduce-job",
      graph_id: "plan-join-reduce-graph",
      node_id: "plan-join-reduce-node",
      child_id: "plan-join-reduce-parent",
    } as const;

    const joinResult = await handlePlanJoin(
      context,
      PlanJoinInputSchema.parse({
        children: ["child-correlation"],
        join_policy: "all",
        timeout_sec: 1,
        ...hints,
      }),
    );
    expect(joinResult.op_id).to.equal(hints.op_id);

    const statusEvent = events.find((event) => event.kind === "STATUS");
    expect(statusEvent, "status event should be recorded").to.not.equal(undefined);
    expect(statusEvent?.correlation?.runId).to.equal(hints.run_id);
    expect(statusEvent?.correlation?.opId).to.equal(hints.op_id);
    expect(statusEvent?.correlation?.jobId).to.equal(hints.job_id);
    expect(statusEvent?.correlation?.graphId).to.equal(hints.graph_id);
    expect(statusEvent?.correlation?.nodeId).to.equal(hints.node_id);
    expect(statusEvent?.correlation?.childId).to.equal(hints.child_id);
    expect(statusEvent?.jobId).to.equal(hints.job_id);
    expect(statusEvent?.childId).to.equal(hints.child_id);
    const statusPayload = (statusEvent?.payload ?? {}) as Record<string, unknown>;
    expect(statusPayload.run_id).to.equal(hints.run_id);
    expect(statusPayload.op_id).to.equal(hints.op_id);
    expect(statusPayload.job_id).to.equal(hints.job_id);
    expect(statusPayload.graph_id).to.equal(hints.graph_id);
    expect(statusPayload.node_id).to.equal(hints.node_id);
    expect(statusPayload.child_id).to.equal(hints.child_id);

    const reduceResult = await handlePlanReduce(
      context,
      PlanReduceInputSchema.parse({
        children: ["child-correlation"],
        reducer: "concat",
        spec: undefined,
        ...hints,
      }),
    );
    expect(reduceResult.op_id).to.equal(hints.op_id);

    const aggregateEvent = events.find((event) => event.kind === "AGGREGATE");
    expect(aggregateEvent, "aggregate event should be recorded").to.not.equal(undefined);
    expect(aggregateEvent?.correlation?.runId).to.equal(hints.run_id);
    expect(aggregateEvent?.correlation?.opId).to.equal(hints.op_id);
    expect(aggregateEvent?.correlation?.jobId).to.equal(hints.job_id);
    expect(aggregateEvent?.correlation?.graphId).to.equal(hints.graph_id);
    expect(aggregateEvent?.correlation?.nodeId).to.equal(hints.node_id);
    expect(aggregateEvent?.correlation?.childId).to.equal(hints.child_id);
    expect(aggregateEvent?.jobId).to.equal(hints.job_id);
    expect(aggregateEvent?.childId).to.equal(hints.child_id);
    const aggregatePayload = (aggregateEvent?.payload ?? {}) as Record<string, unknown>;
    expect(aggregatePayload.run_id).to.equal(hints.run_id);
    expect(aggregatePayload.op_id).to.equal(hints.op_id);
    expect(aggregatePayload.job_id).to.equal(hints.job_id);
    expect(aggregatePayload.graph_id).to.equal(hints.graph_id);
    expect(aggregatePayload.node_id).to.equal(hints.node_id);
    expect(aggregatePayload.child_id).to.equal(hints.child_id);
  });

  it("joins child responses using different policies and aggregates outputs", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-join-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
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
      expect(joinAll.op_id).to.be.a("string");
      expect(joinAll.op_id).to.match(/^plan_join_op_/);
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
      expect(joinFirst.op_id).to.be.a("string");
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

      const thoughtAfterJoins = graphState.getThoughtGraph(fanout.job_id);
      expect(thoughtAfterJoins, "thought graph snapshot should persist after joins").to.not.equal(null);
      const joinedBranches = thoughtAfterJoins!.nodes.filter((node) => node.parents.includes(`run:${fanout.run_id}`));
      expect(joinedBranches.every((node) => ["completed", "errored", "pruned"].includes(node.status))).to.equal(true);
      const joinedWinner = joinedBranches.find((node) => node.id === joinFirst.winning_child_id);
      expect(joinedWinner?.status).to.equal("completed");
      expect(joinedWinner?.result).to.be.a("string");

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
      expect(reduceConcat.op_id).to.be.a("string");
      expect(reduceConcat.aggregate).to.be.a("string");
      expect(reduceConcat.trace.per_child).to.have.length(3);

      const reduceMerge = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "merge_json",
        }),
      );
      expect(reduceMerge.op_id).to.be.a("string");
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
      expect(reduceVote.op_id).to.be.a("string");
      expect(reduceVote.reducer).to.equal("vote");
      expect(reduceVote.trace.details).to.have.property("consensus");
      const consensusDetails = reduceVote.trace.details?.consensus as
        | {
          mode: string;
          tally?: Record<string, number>;
          value?: unknown;
        }
        | undefined;
      expect(consensusDetails).to.be.an("object");
      expect(consensusDetails?.mode).to.equal("majority");
      expect(consensusDetails?.value).to.equal("A");
      expect(consensusDetails?.tally).to.be.an("object");
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

  it("satisfies quorum joins when a stubborn child times out", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-tools-quorum-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
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
          goal: "Valider un quorum",
          prompt_template: {
            system: "Clone {{child_name}}",
            user: "But: {{goal}}",
          },
          children_spec: {
            list: [
              { name: "alpha" },
              { name: "beta" },
              {
                name: "gamma",
                command: process.execPath,
                args: stubbornRunnerArgs(),
              },
            ],
          },
        }),
      );

      // The stubborn runner acknowledges prompts without emitting a terminal
      // response, forcing the join helper to handle the timeout branch while
      // the other clones succeed immediately.

      const responsive = fanout.child_ids.slice(0, 2);
      for (const childId of responsive) {
        // Confirm each cooperative child produced the initial prompt response so
        // quorum accounting observes two terminal messages before the timeout.
        await supervisor.waitForMessage(
          childId,
          (message) => {
            const parsed = message.parsed as { type?: string } | null;
            return message.stream === "stdout" && parsed?.type === "response";
          },
          2000,
        );
      }

      const join = await handlePlanJoin(
        context,
        PlanJoinInputSchema.parse({
          children: fanout.child_ids,
          join_policy: "quorum",
          quorum_count: 2,
          timeout_sec: 1,
        }),
      );
      expect(join.op_id).to.be.a("string");

      expect(join.policy).to.equal("quorum");
      expect(join.quorum_threshold).to.equal(2);
      expect(join.satisfied).to.equal(true);
      expect(join.success_count).to.equal(2);
      expect(join.failure_count).to.equal(1);

      const statuses = new Map(join.results.map((result) => [result.child_id, result.status]));
      expect(statuses.get(responsive[0])).to.equal("success");
      expect(statuses.get(responsive[1])).to.equal("success");
      const stubbornId = fanout.child_ids[2];
      expect(statuses.get(stubbornId)).to.equal("timeout");
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
