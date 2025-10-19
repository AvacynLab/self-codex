import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "chai";

/**
 * Charge le contenu brut du script d'installation orchestrateur.
 *
 * Centraliser la lecture évite de répéter la résolution du chemin dans chaque test.
 */
function readSetupScript(): string {
  const scriptPath = resolve(process.cwd(), "scripts", "setup-agent-env.sh");
  return readFileSync(scriptPath, "utf8");
}

describe("scripts/setup-agent-env.sh", () => {
  it("neutralise les proxys npm avant la première commande npm", () => {
    const script = readSetupScript();
    const lines = script.split(/\r?\n/);

    const firstNpmIndex = lines.findIndex((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        return false;
      }

      return /^(?:run_with_dev_env\s+)?(?:npm|npx)\b/.test(trimmed);
    });
    expect(firstNpmIndex, "le script devrait invoquer npm au moins une fois").to.be.greaterThan(-1);

    const neutralisers = [
      "unset NPM_CONFIG_PRODUCTION",
      "unset NPM_CONFIG_OMIT",
      "unset NPM_CONFIG_HTTP_PROXY",
      "unset NPM_CONFIG_HTTPS_PROXY",
      "unset npm_config_http_proxy",
      "unset npm_config_https_proxy",
    ];

    for (const marker of neutralisers) {
      const markerIndex = lines.findIndex((line) => line.includes(marker));
      expect(
        markerIndex,
        `${marker} doit exister pour neutraliser la configuration npm`,
      ).to.be.greaterThan(-1);
      expect(
        markerIndex,
        `${marker} doit apparaître avant la première commande npm`,
      ).to.be.lessThan(firstNpmIndex);
    }
  });

  it("définit un garde HTTP explicite pour START_HTTP", () => {
    const script = readSetupScript();

    expect(script).to.match(/START_HTTP=1 sans MCP_HTTP_TOKEN/);
    expect(script).to.match(/exit 3/);
    expect(script).to.match(/MCP_HTTP_ALLOW_NOAUTH/);
  });

  it("met en place un nettoyage du serveur HTTP via trap", () => {
    const script = readSetupScript();

    expect(script).to.match(/trap cleanup EXIT INT TERM/);
    expect(script).to.match(/SERVER_PID_FILE=/);
    expect(script).to.match(/rm -f "\$\{SERVER_PID_FILE\}"/);
  });
});

