import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../../src/childSupervisor.js";
import { GraphState } from "../../src/graphState.js";
import { StructuredLogger } from "../../src/logger.js";
import { LessonsStore } from "../../src/learning/lessons.js";
import { PlanFanoutInputSchema, handlePlanFanout, type PlanToolContext } from "../../src/tools/planTools.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";

/**
 * Scenario-level regression confirming that institutional lessons materially
 * change planner prompts. The harness executes the real fan-out pipeline twice:
 * once without lessons (baseline) and once after recording a reminder asking
 * for a regression test. The evaluation score increases from 0 to 1 when the
 * lesson injection succeeds, demonstrating measurable impact.
 */

const mockRunnerPath = fileURLToPath(new URL("../fixtures/mock-runner.js", import.meta.url));

interface ScenarioResult {
  /** Summary string sent to the mock child runtime. */
  summary: string;
  /** Identifier of the spawned child so we can trace which run produced the output. */
  childId: string;
}

function createPlanContext(options: {
  childrenRoot: string;
  supervisor: ChildSupervisor;
  graphState: GraphState;
  logger: StructuredLogger;
  lessonsStore: LessonsStore;
}): PlanToolContext {
  return {
    supervisor: options.supervisor,
    graphState: options.graphState,
    logger: options.logger,
    childrenRoot: options.childrenRoot,
    defaultChildRuntime: "codex",
    emitEvent: () => {
      /* the scenario harness focuses on prompt shaping so events are ignored */
    },
    stigmergy: new StigmergyField(),
    lessonsStore: options.lessonsStore,
  };
}

async function runScenarioIteration(lessonsStore: LessonsStore): Promise<ScenarioResult> {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "lessons-scenario-"));
  const supervisor = new ChildSupervisor({
    childrenRoot,
    defaultCommand: process.execPath,
    defaultArgs: [mockRunnerPath],
  });
  const graphState = new GraphState();
  const orchestratorLog = path.join(childrenRoot, "tmp", "orchestrator.log");
  const logger = new StructuredLogger({ logFile: orchestratorLog });
  const context = createPlanContext({
    childrenRoot,
    supervisor,
    graphState,
    logger,
    lessonsStore,
  });

  try {
    const input = PlanFanoutInputSchema.parse({
      goal: "Corriger un bug critique tout en évitant les régressions.",
      prompt_template: {
        system: "Tu es {{child_name}}, un clone spécialisé en {{specialty}}.",
        user: [
          "Ton objectif est: {{goal}}",
          "Présente une stratégie résumée pour y parvenir.",
        ],
      },
      children_spec: {
        list: [
          {
            name: "auditeur",
            prompt_variables: {
              specialty: "revue de correctifs",
            },
          },
        ],
      },
      parallelism: 1,
      retry: { max_attempts: 1, delay_ms: 0 },
    });

    const planned = await handlePlanFanout(context, input);
    if (planned.planned.length === 0) {
      throw new Error("plan fanout did not schedule any child");
    }

    const plannedChild = planned.planned[0];
    return {
      summary: plannedChild.prompt_summary,
      childId: plannedChild.child_id,
    };
  } finally {
    await logger.flush();
    await supervisor.disposeAll();
    await rm(childrenRoot, { recursive: true, force: true });
  }
}

/**
 * Small heuristic scoring helper returning 1 when the prompt summary explicitly
 * asks for a "test de non-régression". Accents and hyphen variants are
 * normalised so the metric remains stable across locales.
 */
function computeScenarioScore(summary: string): number {
  const normalised = summary
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[‐‑–—]/g, "-")
    .toLowerCase();
  return normalised.includes("test de non-regression") ? 1 : 0;
}

describe("lessons scenario harness", function () {
  this.timeout(20000);

  it("improves the evaluation score after recording a corrective lesson", async () => {
    const lessonsStore = new LessonsStore();

    const baseline = await runScenarioIteration(lessonsStore);
    const baselineScore = computeScenarioScore(baseline.summary);
    expect(baselineScore, "baseline prompts should miss the regression guardrail").to.equal(0);

    lessonsStore.record({
      topic: "planning.tests-required",
      summary: "Toujours prévoir un test de non-régression pour chaque correction annoncée.",
      tags: ["plan", "quality", "tests"],
      importance: 0.9,
      confidence: 0.85,
      evidence: "Ajoute un test ciblant le bug initial.",
    });

    const improved = await runScenarioIteration(lessonsStore);
    const improvedScore = computeScenarioScore(improved.summary);

    expect(improvedScore, "lesson-guided prompts should mention non-régression explicitly").to.equal(1);
    expect(improved.childId, "each run spawns a dedicated child").to.not.equal(baseline.childId);
  });
});
