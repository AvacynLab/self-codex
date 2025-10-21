import { expect } from "chai";

import type { EventEnvelope } from "../../src/events/bus.js";
import type { EventMessage, EventPayload } from "../../src/events/types.js";

/**
 * Returns `true` when the provided value is a plain object record. The helper is
 * intentionally strict so tests avoid accidentally treating arrays or `null`
 * values as structured payloads when they inspect event metadata.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asserts that the provided value is a plain object record. Tests rely on this
 * guard before dereferencing properties coming from dynamic JSON responses.
 */
export function assertPlainObject(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  expect(isPlainObject(value), `${description} should be a plain object`).to.equal(true);
}

/**
 * Asserts that the provided value is an array. The generic parameter keeps the
 * type-checker aware of the intended element type once the guard succeeds.
 */
export function assertArray<T = unknown>(value: unknown, description: string): asserts value is T[] {
  expect(Array.isArray(value), `${description} should be an array`).to.equal(true);
}

/**
 * Asserts that the provided value is a string. Tests call this helper when they
 * require a specific correlation identifier (run id, job id, …) to be present.
 */
export function assertString(value: unknown, description: string): asserts value is string {
  expect(typeof value, `${description} should be a string`).to.equal("string");
}

/**
 * Asserts that the provided value is a number. The helper keeps telemetry checks
 * honest by guaranteeing that arithmetic operations only run on numeric inputs.
 */
export function assertNumber(value: unknown, description: string): asserts value is number {
  expect(typeof value, `${description} should be a number`).to.equal("number");
}

/**
 * Runtime guard ensuring an event envelope exposes the expected message and a
 * non-`undefined` payload. Narrowing through this helper lets subsequent
 * assertions interact with the structured data without falling back to casts.
 */
export function hasEventPayload<M extends EventMessage>(
  envelope: EventEnvelope,
  message: M,
): envelope is EventEnvelope<M> & { data: EventPayload<M> } {
  return envelope.msg === message && envelope.data !== undefined;
}

/**
 * Asserts the envelope carries the expected message and returns the associated
 * payload. The helper builds upon {@link hasEventPayload} to provide a concise
 * way of extracting typed payloads in behavioural tests.
 */
export function expectEventPayload<M extends EventMessage>(
  envelope: EventEnvelope,
  message: M,
): EventPayload<M> {
  expect(hasEventPayload(envelope, message), `event should carry a ${message} payload`).to.equal(true);
  return envelope.data;
}
