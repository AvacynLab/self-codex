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
      "600"
    ]);
    expect(result.parallelism).to.equal(4);
    expect(result.childIdleSec).to.equal(45);
    expect(result.childTimeoutSec).to.equal(600);
  });

  it("rejette les valeurs invalides pour les nouveaux flags", () => {
    expect(() => parseOrchestratorRuntimeOptions(["--parallelism", "0"]))
      .to.throw("La valeur 0 pour --parallelism doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--child-idle-sec", "-5"]))
      .to.throw("La valeur -5 pour --child-idle-sec doit être un entier positif.");
    expect(() => parseOrchestratorRuntimeOptions(["--child-timeout-sec", "abc"]))
      .to.throw("La valeur abc pour --child-timeout-sec doit être un entier positif.");
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
