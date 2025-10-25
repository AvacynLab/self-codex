import { describe, it } from "mocha";
import { expect } from "chai";

import { renderMermaidFromGraph } from "../src/viz/mermaid.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

/**
 * Regression tests covering the overlay features applied during Mermaid export.
 * The scenarios ensure stigmergic intensities translate into CSS classes and
 * Behaviour Tree statuses surface as badges without breaking escaping.
 */
describe("Mermaid overlays", () => {
  const baseDescriptor: GraphDescriptorPayload = {
    name: "overlay-demo",
    nodes: [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ],
    edges: [
      { from: "alpha", to: "beta" },
      { from: "beta", to: "gamma" },
    ],
  };

  it("assigns stigmergic classes based on relative intensity", () => {
    const mermaid = renderMermaidFromGraph(baseDescriptor, {
      stigmergyOverlay: {
        intensities: {
          alpha: 1,
          beta: 5,
          gamma: 3,
        },
      },
    });

    expect(mermaid).to.include("classDef stig-low");
    expect(mermaid).to.include("classDef stig-medium");
    expect(mermaid).to.include("classDef stig-high");
    expect(mermaid).to.include("class alpha stig-low");
    expect(mermaid).to.include("class beta stig-high");
    expect(mermaid).to.include("class gamma stig-medium");
  });

  it("embeds Behaviour Tree badges and styling for node statuses", () => {
    const mermaid = renderMermaidFromGraph(baseDescriptor, {
      behaviorStatusOverlay: {
        statuses: {
          alpha: "running",
          beta: "success",
          gamma: "ko",
        },
      },
    });

    const runningLabel = 'alpha["Alpha\\n⏱ RUNNING"]';
    const successLabel = 'beta["Beta\\n✅ OK"]';
    const failureLabel = 'gamma["Gamma\\n❌ KO"]';
    expect(mermaid).to.include(runningLabel);
    expect(mermaid).to.include(successLabel);
    expect(mermaid).to.include(failureLabel);
    expect(mermaid).to.include("class alpha bt-running");
    expect(mermaid).to.include("class beta bt-success");
    expect(mermaid).to.include("class gamma bt-failure");
    expect(mermaid).to.include("classDef bt-running");
    expect(mermaid).to.include("classDef bt-success");
    expect(mermaid).to.include("classDef bt-failure");
  });
});

