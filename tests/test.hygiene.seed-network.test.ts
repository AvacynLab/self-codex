import { describe, it } from "mocha";
import { expect } from "chai";
import * as http from "node:http";
import * as https from "node:https";
import {
  createDeterministicRandom,
  DEFAULT_TEST_RANDOM_SEED,
} from "./setup";

/**
 * These regression tests validate the guarantees provided by `tests/setup.ts`:
 * deterministic randomness and blocked outbound networking.
 */
describe("test hygiene guards", () => {
  it("produces deterministic sequences for identical seeds", () => {
    const generatorA = createDeterministicRandom(DEFAULT_TEST_RANDOM_SEED);
    const generatorB = createDeterministicRandom(DEFAULT_TEST_RANDOM_SEED);

    const sequenceA = [generatorA(), generatorA(), generatorA()];
    const sequenceB = [generatorB(), generatorB(), generatorB()];

    expect(sequenceA).to.deep.equal(sequenceB);
    expect(sequenceA[0]).to.be.closeTo(0.7463903471328228, 1e-12);
    expect(sequenceA[1]).to.be.closeTo(0.008452148650262644, 1e-12);
    expect(sequenceA[2]).to.be.closeTo(0.9936897847742678, 1e-12);
  });

  it("produces distinct sequences for different seeds", () => {
    const generatorDefault = createDeterministicRandom(DEFAULT_TEST_RANDOM_SEED);
    const generatorAlt = createDeterministicRandom("alternative-seed");

    const defaultSequence = [
      generatorDefault(),
      generatorDefault(),
      generatorDefault(),
    ];
    const altSequence = [generatorAlt(), generatorAlt(), generatorAlt()];

    expect(defaultSequence).to.not.deep.equal(altSequence);
  });

  it("rejects accidental http requests", () => {
    expect(() => http.request("http://example.com"))
      .to.throw(Error)
      .with.property("code", "E-NETWORK-BLOCKED");
  });

  it("rejects accidental https requests", () => {
    expect(() => https.request("https://example.com"))
      .to.throw(Error)
      .with.property("code", "E-NETWORK-BLOCKED");
  });
});

