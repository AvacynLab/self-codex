import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { ValueGraph } from "../src/values/valueGraph.js";
import { StructuredLogger, type LogEntry } from "../src/logger.js";
import {
  handleValuesSet,
  handleValuesScore,
  handleValuesFilter,
  handleValuesExplain,
  ValuesSetInputSchema,
  ValuesScoreInputSchema,
  ValuesFilterInputSchema,
  ValuesExplainInputSchema,
  type ValueToolContext,
} from "../src/tools/valueTools.js";

/**
 * Regression suite ensuring every value guard tool surfaces a correlation
 * identifier (`op_id`) and propagates it to structured logs for observability.
 */
describe("value tool operation identifiers", () => {
  let graph: ValueGraph;
  let entries: LogEntry[];
  let context: ValueToolContext;

  beforeEach(() => {
    graph = new ValueGraph();
    entries = [];
    context = {
      valueGraph: graph,
      logger: new StructuredLogger({ onEntry: (entry) => entries.push(entry) }),
    };
  });

  it("generates and logs op_id values across the tool catalogue", () => {
    const setInput = ValuesSetInputSchema.parse({
      values: [
        { id: "privacy", weight: 1, tolerance: 0.25 },
        { id: "safety", weight: 0.8, tolerance: 0.4 },
      ],
      relationships: [{ from: "privacy", to: "safety", kind: "supports", weight: 0.5 }],
      default_threshold: 0.7,
    });
    const setResult = handleValuesSet(context, setInput);
    expect(setResult.op_id).to.match(/^values_set_op_/);

    const setLog = entries.find((entry) => entry.message === "values_set");
    expect(setLog?.payload).to.include({ op_id: setResult.op_id });

    const scoreInput = ValuesScoreInputSchema.parse({
      id: "plan-alpha",
      label: "Alpha plan",
      impacts: [
        { value: "privacy", impact: "support", severity: 0.9, rationale: "encrypts" },
        { value: "safety", impact: "risk", severity: 0.3, rationale: "reduces review" },
      ],
    });
    const scoreResult = handleValuesScore(context, scoreInput);
    expect(scoreResult.op_id).to.match(/^values_score_op_/);
    expect(scoreResult.decision.allowed).to.equal(true);

    const scoreLog = entries.find((entry) => entry.message === "values_score");
    expect(scoreLog?.payload).to.include({ op_id: scoreResult.op_id });

    const filterInput = ValuesFilterInputSchema.parse({
      id: "plan-beta",
      impacts: [
        { value: "privacy", impact: "risk", severity: 0.8, rationale: "exports raw" },
        { value: "safety", impact: "risk", severity: 0.7, rationale: "skips review" },
      ],
    });
    const filterResult = handleValuesFilter(context, filterInput);
    expect(filterResult.op_id).to.match(/^values_filter_op_/);
    expect(filterResult.allowed).to.equal(false);

    const filterLog = entries.find((entry) => entry.message === "values_filter");
    expect(filterLog?.payload).to.include({ op_id: filterResult.op_id });

    const explainInput = ValuesExplainInputSchema.parse({
      plan: {
        id: "plan-beta",
        impacts: filterInput.impacts,
      },
    });
    const explainResult = handleValuesExplain(context, explainInput);
    expect(explainResult.op_id).to.match(/^values_explain_op_/);
    expect(explainResult.decision.allowed).to.equal(false);

    const explainLog = entries.find((entry) => entry.message === "values_explain");
    expect(explainLog?.payload).to.include({ op_id: explainResult.op_id });
  });
});
