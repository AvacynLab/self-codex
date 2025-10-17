import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import { PlanFanoutInputSchema, handlePlanFanout, type PlanToolContext } from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import type { EventCorrelationHints } from "../src/events/correlation.js";
import { LessonsStore } from "../src/learning/lessons.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

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
  lessonsStore: LessonsStore;
  events: RecordedEvent[];
}): PlanToolContext {
  const stigmergy = new StigmergyField();
  return {
    supervisor: options.supervisor,
    graphState: options.graphState,
    logger: options.logger,
    childrenRoot: options.childrenRoot,
    defaultChildRuntime: "codex",
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
    lessonsStore: options.lessonsStore,
  };
}

describe("plan tools lessons integration", () => {
  it("injects recalled lessons into fan-out prompts", async function () {
    this.timeout(10000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-lessons-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const orchestratorLog = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile: orchestratorLog });
    const lessonsStore = new LessonsStore();
    const events: RecordedEvent[] = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, lessonsStore, events });

    lessonsStore.record({
      topic: "planning.tests-required",
      summary: "Toujours prévoir un test de non-régression pour chaque correction annoncée.",
      tags: ["plan", "quality"],
      importance: 0.9,
      confidence: 0.8,
    });

    try {
      const input = PlanFanoutInputSchema.parse({
        goal: "Préparer le correctif d'un bug",
        prompt_template: {
          system: "Clone {{child_name}} spécialisé en {{specialty}}.",
          user: [
            "Contexte: {{goal}}",
            "Ton identifiant est {{child_index}}",
          ],
        },
        children_spec: {
          list: [
            { name: "analyste", prompt_variables: { specialty: "analyse" } },
            { name: "testeur", prompt_variables: { specialty: "tests" } },
          ],
        },
        parallelism: 1,
        retry: { max_attempts: 1, delay_ms: 0 },
      });

      const result = await handlePlanFanout(context, input);
      expect(result.planned).to.have.lengthOf(2);
      const firstPrompt = result.planned[0];
      expect(firstPrompt.prompt_messages[0].role).to.equal("system");
      expect(firstPrompt.prompt_messages[0].content).to.include("Leçons institutionnelles pertinentes");
      expect(firstPrompt.prompt_messages[0].content).to.include("non-régression");

      const manifestRaw = await readFile(firstPrompt.manifest_path, "utf8");
      const manifest = JSON.parse(manifestRaw) as { lessons_context?: { matches?: Array<{ topic: string }> } };
      expect(manifest.lessons_context?.matches?.some((match) => match.topic === "planning.tests-required")).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
