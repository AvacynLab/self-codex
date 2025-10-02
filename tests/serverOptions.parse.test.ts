/**
 * Ces tests vérifient que le parseur d'options CLI expose correctement les
 * paramètres nécessaires à la planification multi-enfants et garde une
 * validation stricte sur les entrées utilisateur.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { parseOrchestratorRuntimeOptions, createHttpSessionId } from "../src/serverOptions.js";

describe("parseOrchestratorRuntimeOptions", () => {
  it("retourne la configuration stdio par défaut", () => {
    const result = parseOrchestratorRuntimeOptions([]);
    expect(result.enableStdio).to.equal(true);
    expect(result.http.enabled).to.equal(false);
    expect(result.http.port).to.equal(4000);
    expect(result.http.host).to.equal("0.0.0.0");
    expect(result.http.path).to.equal("/mcp");
    expect(result.maxEventHistory).to.equal(5000);
    expect(result.logFile).to.equal(null);
    expect(result.parallelism).to.equal(2);
    expect(result.childIdleSec).to.equal(120);
    expect(result.childTimeoutSec).to.equal(900);
    expect(result.enableReflection).to.equal(true);
    expect(result.enableQualityGate).to.equal(true);
    expect(result.qualityThreshold).to.equal(70);
    expect(result.features).to.deep.equal({
      enableBT: false,
      enableReactiveScheduler: false,
      enableBlackboard: false,
      enableStigmergy: false,
      enableCNP: false,
      enableConsensus: false,
      enableAutoscaler: false,
      enableSupervisor: false,
      enableKnowledge: false,
      enableCausalMemory: false,
      enableValueGuard: false,
    });
    expect(result.timings).to.deep.equal({
      btTickMs: 50,
      stigHalfLifeMs: 30_000,
      supervisorStallTicks: 6,
    });
    expect(result.dashboard).to.deep.equal({
      enabled: false,
      host: "127.0.0.1",
      port: 4100,
      streamIntervalMs: 2_000,
    });
    expect(result.safety).to.deep.equal({
      maxChildren: 16,
      memoryLimitMb: 512,
      cpuPercent: 100,
    });
  });

  it("accepte les options HTTP explicites", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--http",
      "--http-port",
      "8080",
      "--http-host",
      "127.0.0.1",
      "--http-path",
      "bridge",
      "--http-json",
      "--http-stateless"
    ]);
    expect(result.http.enabled).to.equal(true);
    expect(result.http.port).to.equal(8080);
    expect(result.http.host).to.equal("127.0.0.1");
    expect(result.http.path).to.equal("/bridge");
    expect(result.http.enableJson).to.equal(true);
    expect(result.http.stateless).to.equal(true);
  });

  it("configure le dashboard lorsque les flags sont fournis", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--dashboard",
      "--dashboard-host",
      "0.0.0.0",
      "--dashboard-port",
      "4500",
      "--dashboard-interval-ms",
      "500",
    ]);

    expect(result.dashboard).to.deep.equal({
      enabled: true,
      host: "0.0.0.0",
      port: 4500,
      streamIntervalMs: 500,
    });
  });

  it("applique le seuil d'historique des événements", () => {
    const result = parseOrchestratorRuntimeOptions(["--max-event-history", "2500"]);
    expect(result.maxEventHistory).to.equal(2500);
  });

  it("active la journalisation fichier lorsque --log-file est fourni", () => {
    const result = parseOrchestratorRuntimeOptions(["--log-file", "./orchestrator.log"]);
    expect(result.logFile).to.equal("./orchestrator.log");
  });

  it("configure la planification des enfants via les nouveaux flags", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--parallelism",
      "4",
      "--child-idle-sec",
      "45",
      "--child-timeout-sec",
      "600",
      "--max-children",
      "5",
      "--child-memory-mb",
      "1024",
      "--child-cpu-percent",
      "150",
    ]);
    expect(result.parallelism).to.equal(4);
    expect(result.childIdleSec).to.equal(45);
    expect(result.childTimeoutSec).to.equal(600);
    expect(result.safety).to.deep.equal({ maxChildren: 5, memoryLimitMb: 1024, cpuPercent: 100 });
  });

  it("rejette les valeurs invalides pour les nouveaux flags", () => {
    expect(() => parseOrchestratorRuntimeOptions(["--parallelism", "0"]))
      .to.throw("La valeur 0 pour --parallelism doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--child-idle-sec", "-5"]))
      .to.throw("La valeur -5 pour --child-idle-sec doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--child-timeout-sec", "abc"]))
      .to.throw("La valeur abc pour --child-timeout-sec doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--max-children", "0"]))
      .to.throw("La valeur 0 pour --max-children doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--child-memory-mb", "nan"]))
      .to.throw("La valeur nan pour --child-memory-mb doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--dashboard-host", " "]))
      .to.throw("L'hôte du dashboard ne peut pas être vide.");
  });

  it("permet de désactiver réflexion et quality gate", () => {
    const result = parseOrchestratorRuntimeOptions(["--no-reflection", "--no-quality-gate"]);
    expect(result.enableReflection).to.equal(false);
    expect(result.enableQualityGate).to.equal(false);
  });

  it("active sélectivement les modules optionnels", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--enable-bt",
      "--enable-reactive-scheduler",
      "--enable-blackboard",
      "--enable-stigmergy",
      "--enable-cnp",
      "--enable-consensus",
      "--enable-autoscaler",
      "--enable-supervisor",
      "--enable-knowledge",
      "--enable-causal-memory",
      "--enable-value-guard",
    ]);

    expect(result.features).to.deep.equal({
      enableBT: true,
      enableReactiveScheduler: true,
      enableBlackboard: true,
      enableStigmergy: true,
      enableCNP: true,
      enableConsensus: true,
      enableAutoscaler: true,
      enableSupervisor: true,
      enableKnowledge: true,
      enableCausalMemory: true,
      enableValueGuard: true,
    });
  });

  it("applique les délais personnalisés", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--bt-tick-ms",
      "75",
      "--stig-half-life-ms",
      "45000",
      "--supervisor-stall-ticks",
      "9",
      "--dashboard",
      "--dashboard-interval-ms",
      "100",
    ]);

    expect(result.timings).to.deep.equal({
      btTickMs: 75,
      stigHalfLifeMs: 45_000,
      supervisorStallTicks: 9,
    });
    expect(result.dashboard.streamIntervalMs).to.equal(250);
  });

  it("applique le seuil qualité lorsque fourni", () => {
    const result = parseOrchestratorRuntimeOptions(["--quality-threshold", "55"]);
    expect(result.qualityThreshold).to.equal(55);
    expect(result.enableQualityGate).to.equal(true);
  });

  it("rejette un seuil qualité hors bornes", () => {
    expect(() => parseOrchestratorRuntimeOptions(["--quality-threshold", "150"]))
      .to.throw("La valeur 150 pour --quality-threshold doit être comprise entre 0 et 100.");
  });

  it("rejette un fichier de log vide", () => {
    expect(() => parseOrchestratorRuntimeOptions(["--log-file", " "]))
      .to.throw("Le chemin du fichier de log ne peut pas être vide.");
  });

  it("fournit un identifiant de session UUID", () => {
    const id = createHttpSessionId();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).to.match(uuidPattern);
  });
});
