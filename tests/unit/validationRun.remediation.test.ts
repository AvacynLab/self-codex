import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";

import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import {
  generateRemediationPlan,
  renderRemediationMarkdown,
  writeRemediationPlan,
} from "../../src/validationRun/remediation.js";
import { type ScenarioSnapshot } from "../../src/validationRun/reports.js";

function buildScenarioSnapshot(partial: Partial<ScenarioSnapshot> & Pick<ScenarioSnapshot, "slug" | "id" | "label" | "description">): ScenarioSnapshot {
  return {
    timings: undefined,
    errorEntries: [],
    errorCounts: {},
    documentsIngested: undefined,
    tookMs: undefined,
    eventsCount: undefined,
    kgChangesCount: undefined,
    vectorUpsertsCount: undefined,
    serverLogLines: undefined,
    notes: [],
    ...partial,
  } as ScenarioSnapshot;
}

describe("validationRun/remediation", () => {
  const tmpRoot = path.join(process.cwd(), "tmp", "remediation-test");

  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("suggère des actions pour les critères en échec et les erreurs récurrentes", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);

    const scenarios: ScenarioSnapshot[] = [
      buildScenarioSnapshot({
        id: 1,
        slug: "S01_pdf_science",
        label: "S01 – PDF scientifique",
        description: "Recherche PDF",
        notes: ["timings.json: fichier manquant"],
        errorCounts: { network_error: 2, robots_denied: 1 },
      }),
      buildScenarioSnapshot({
        id: 6,
        slug: "S06_robots_taille_max",
        label: "S06 – robots & taille max",
        description: "Téléchargement volumineux",
        errorCounts: { max_size_exceeded: 3 },
      }),
      buildScenarioSnapshot({
        id: 7,
        slug: "S07_sources_instables",
        label: "S07 – Sources instables",
        description: "Timeouts",
        errorCounts: { parse_error: 1 },
      }),
    ];

    const plan = await generateRemediationPlan({
      layout,
      summary: {
        generatedAt: "2025-12-05T07:00:00.000Z",
        scenarios,
        totals: {
          documentsIngested: 0,
          events: 0,
          kgChanges: 0,
          vectorUpserts: 0,
          errors: {},
        },
        acceptance: {
          functional: {
            status: "fail",
            details: "S01 ne comporte ni documents ni erreurs classées.",
            scenarios: ["S01_pdf_science"],
          },
          idempotence: {
            status: "pass",
            details: "DocIds identiques pour S01/S05.",
            scenarios: ["S01_pdf_science", "S05_idempotence"],
          },
          extraction: {
            status: "unknown",
            details: "Vector chunks manquants pour plusieurs scénarios.",
          },
          language: {
            status: "pass",
            details: "Taux de détection ≥ 90%.",
            scenarios: ["S01_pdf_science"],
          },
          ragQuality: {
            status: "fail",
            details: "La réponse S10 ne cite pas tous les documents.",
            scenarios: ["S10_qualite_rag"],
          },
          performance: {
            status: "fail",
            details: "Latence p95 searxQuery supérieure à 3s.",
            scenarios: ["S09_charge_moderee"],
          },
          robustness: {
            status: "pass",
            details: "Les erreurs sont correctement classées.",
            scenarios: ["S07_sources_instables"],
          },
        },
      },
      now: new Date("2025-12-05T08:00:00Z"),
    });

    expect(plan.status).to.equal("blocked");
    expect(plan.actions.some((action) => action.criterion === "functional" && action.severity === "critical")).to.equal(true);
    expect(plan.actions.some((action) => action.criterion === "performance" && action.severity === "critical")).to.equal(true);
    expect(plan.actions.some((action) => action.criterion === "extraction" && action.severity === "attention")).to.equal(true);
    expect(plan.actions.some((action) => action.criterion === "S01_pdf_science")).to.equal(true);
    expect(plan.actions.some((action) => action.criterion === "erreur:network_error")).to.equal(true);
    expect(plan.actions.some((action) => action.criterion === "erreur:max_size_exceeded")).to.equal(true);

    const markdown = renderRemediationMarkdown(plan);
    expect(markdown).to.contain("Plan de remédiation");
    expect(markdown).to.contain("Statut global : blocked");
    expect(markdown).to.contain("timings.json: fichier manquant");
    expect(markdown).to.contain("erreur:network_error");
  });

  it("écrit les fichiers JSON et Markdown et note l'absence d'actions", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const planResult = await writeRemediationPlan({
      layout,
      summary: {
        generatedAt: "2025-12-05T09:00:00.000Z",
        scenarios: [
          buildScenarioSnapshot({
            id: 1,
            slug: "S01_pdf_science",
            label: "S01",
            description: "",
          }),
        ],
        totals: {
          documentsIngested: 0,
          events: 0,
          kgChanges: 0,
          vectorUpserts: 0,
          errors: {},
        },
        acceptance: {
          functional: { status: "pass", details: "OK", scenarios: ["S01_pdf_science"] },
          idempotence: { status: "pass", details: "OK", scenarios: ["S01_pdf_science", "S05_idempotence"] },
          extraction: { status: "pass", details: "OK", scenarios: ["S01_pdf_science"] },
          language: { status: "pass", details: "OK", scenarios: ["S01_pdf_science"] },
          ragQuality: { status: "pass", details: "OK", scenarios: ["S10_qualite_rag"] },
          performance: { status: "pass", details: "OK", scenarios: ["S09_charge_moderee"] },
          robustness: { status: "pass", details: "OK", scenarios: ["S07_sources_instables"] },
        },
      },
      now: new Date("2025-12-05T09:30:00Z"),
    });

    expect(planResult.plan.status).to.equal("clear");
    expect(planResult.plan.actions).to.have.lengthOf(0);
    expect(planResult.plan.notes[0]).to.contain("Aucune action corrective détectée");

    const writtenJson = JSON.parse(await readFile(planResult.jsonPath, "utf8")) as { status: string };
    expect(writtenJson.status).to.equal("clear");

    const writtenMarkdown = await readFile(planResult.markdownPath, "utf8");
    expect(writtenMarkdown).to.contain("Aucune action requise");
  });
});
