import { describe, it } from "mocha";
import { expect } from "chai";

import {
  PromptTemplatingError,
  PromptTemplateInput,
  extractTemplateVariables,
  parsePromptTemplate,
  renderPromptTemplate,
} from "../src/prompts.js";

describe("prompts", () => {
  it("extracts unique variables from all segments", () => {
    const variables = extractTemplateVariables({
      system: "You are {{role}}",
      user: ["Task {{task}}", "Reference {{reference}}"],
      assistant: "Ack {{task}}",
    });

    expect(variables).to.deep.equal(["reference", "role", "task"]);
  });

  it("renders a full prompt with injected variables", () => {
    const messages = renderPromptTemplate(
      {
        system: "system: {{role}}",
        user: ["Step 1: {{task}}", "Dataset: {{dataset}}"],
      },
      {
        variables: {
          role: "planner",
          task: "analyse logs",
          dataset: "logs.jsonl",
        },
      },
    );

    expect(messages).to.deep.equal([
      { role: "system", content: "system: planner" },
      { role: "user", content: "Step 1: analyse logs" },
      { role: "user", content: "Dataset: logs.jsonl" },
    ]);
  });

  it("throws an explicit error when a variable is missing", () => {
    expect(() =>
      renderPromptTemplate(
        { system: "Hello {{name}}" },
        { variables: {} },
      ),
    ).to.throw(PromptTemplatingError);
  });

  it("rejects nullish variable values", () => {
    expect(() =>
      renderPromptTemplate(
        { system: "Value {{name}}" },
        { variables: { name: null as unknown as string } },
      ),
    ).to.throw(PromptTemplatingError);
  });

  it("validates template structure via zod", () => {
    expect(() =>
      parsePromptTemplate({} as PromptTemplateInput),
    ).to.throw(PromptTemplatingError, /at least one segment/);

    expect(() =>
      parsePromptTemplate({ system: ["ok"], extra: "nope" } as PromptTemplateInput),
    ).to.throw(PromptTemplatingError);
  });

  it("rejects unsupported variable types", () => {
    expect(() =>
      renderPromptTemplate(
        { user: "Value {{payload}}" },
        { variables: { payload: { nested: true } as unknown as string } },
      ),
    ).to.throw(PromptTemplatingError, /Invalid prompt variables/);
  });
});
