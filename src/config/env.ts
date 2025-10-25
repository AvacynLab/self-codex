/**
 * Shared helpers dedicated to reading environment variables in a predictable
 * and well-documented manner. Centralising the parsing logic avoids tiny
 * hand-rolled utilities scattered across the codebase while ensuring operators
 * can rely on consistent coercion rules.
 */
const TRUE_LITERALS = new Set(["1", "true", "yes", "on"]);
const FALSE_LITERALS = new Set(["0", "false", "no", "off"]);

type NormalisedEnvValue = string;

/** Normalises the raw value retrieved from {@link process.env}. */
function normaliseEnvValue(raw: string | undefined): NormalisedEnvValue | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads the provided environment variable and interprets it as a boolean.
 *
 * The helper tolerates human-friendly variants ("1", "true", "yes", "on" for
 * truthy, "0", "false", "no", "off" for falsy) while falling back to the
 * supplied default when the variable is absent or ambiguous.
 */
export function readBool(name: string, defaultValue: boolean): boolean {
  const parsed = readOptionalBool(name);
  return parsed ?? defaultValue;
}

/** Returns an optional boolean if {@link name} is set to a recognised literal. */
export function readOptionalBool(name: string): boolean | undefined {
  const normalised = normaliseEnvValue(process.env[name]);
  if (!normalised) {
    return undefined;
  }

  const lower = normalised.toLowerCase();
  if (TRUE_LITERALS.has(lower)) {
    return true;
  }
  if (FALSE_LITERALS.has(lower)) {
    return false;
  }
  return undefined;
}

interface NumberOptions {
  /** Minimum allowed value (inclusive). */
  readonly min?: number;
  /** Maximum allowed value (inclusive). */
  readonly max?: number;
}

/** Determines whether the provided value fits the numeric constraints. */
function withinBounds(value: number, options: NumberOptions | undefined): boolean {
  // The helpers intentionally reject `Infinity` and `NaN` so downstream callers do
  // not have to guard against arithmetic explosions when an operator supplies an
  // exotic literal such as "Infinity". Returning `false` triggers the default
  // value path in the public readers, keeping behaviour predictable.
  if (!Number.isFinite(value)) {
    return false;
  }
  if (options?.min !== undefined && value < options.min) {
    return false;
  }
  if (options?.max !== undefined && value > options.max) {
    return false;
  }
  return true;
}

/**
 * Reads the environment variable as an integer using base 10. Unexpected
 * values cause the helper to return the provided default.
 */
export function readInt(name: string, defaultValue: number, options?: NumberOptions): number {
  const parsed = readOptionalInt(name, options);
  return parsed ?? defaultValue;
}

/** Returns an optional integer when {@link name} contains a valid base-10 literal. */
export function readOptionalInt(name: string, options?: NumberOptions): number | undefined {
  const normalised = normaliseEnvValue(process.env[name]);
  if (!normalised) {
    return undefined;
  }

  if (!/^[-+]?\d+$/.test(normalised)) {
    return undefined;
  }

  const value = Number.parseInt(normalised, 10);
  // Reject literals that overflow JavaScript's precise integer range to avoid
  // silently rounding extremely large values (e.g. > Number.MAX_SAFE_INTEGER).
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }

  return withinBounds(value, options) ? value : undefined;
}

/**
 * Reads the environment variable as a floating-point number. Invalid input
 * falls back to the supplied default, matching the forgiving behaviour used
 * historically across the codebase.
 */
export function readNumber(name: string, defaultValue: number, options?: NumberOptions): number {
  const parsed = readOptionalNumber(name, options);
  return parsed ?? defaultValue;
}

/** Returns an optional floating-point number when {@link name} contains a finite value. */
export function readOptionalNumber(name: string, options?: NumberOptions): number | undefined {
  const normalised = normaliseEnvValue(process.env[name]);
  if (!normalised) {
    return undefined;
  }

  const value = Number.parseFloat(normalised);
  return withinBounds(value, options) ? value : undefined;
}

interface StringOptions {
  /** When true an empty string is considered a valid explicit override. */
  readonly allowEmpty?: boolean;
}

/**
 * Reads a textual environment variable while trimming surrounding whitespace.
 *
 * The helper mirrors the tolerant behaviour of the existing parsers by treating
 * empty strings as "unset" values unless the caller explicitly opts into empty
 * literals via {@link StringOptions.allowEmpty}. This matches historical
 * expectations where blank overrides disable features while still letting tests
 * assert the distinction between "unset" and "set to empty".
 */
export function readString(name: string, defaultValue: string, options?: StringOptions): string {
  const parsed = readOptionalString(name, options);
  return parsed ?? defaultValue;
}

/**
 * Returns the trimmed string when {@link name} is set to a non-empty value.
 *
 * When {@link StringOptions.allowEmpty} is true, the helper returns the empty
 * string so callers can detect an explicit blank override (for instance to
 * disable optional tokens). In every case the returned value is trimmed to
 * guarantee consistent downstream comparisons.
 */
export function readOptionalString(name: string, options?: StringOptions): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 && options?.allowEmpty !== true) {
    return undefined;
  }
  return trimmed;
}

/**
 * Reads an enum-like string while validating that the value is part of the
 * allowed set. Comparison is case-insensitive to make CLI usage forgiving.
 */
/**
 * Reads an enum-like environment variable while validating that the literal belongs to the
 * supplied allow-list. The helper tolerates mixed-case inputs and ignores surrounding whitespace.
 *
 * Returning `undefined` when the variable is absent or invalid gives callers the flexibility to
 * fall back to context-dependent defaults (e.g. propagate `null` when no override is configured).
 */
export function readOptionalEnum<T extends string>(
  name: string,
  allowed: readonly T[],
): T | undefined {
  const normalised = normaliseEnvValue(process.env[name]);
  if (!normalised) {
    return undefined;
  }

  const lookup = new Map<string, T>();
  for (const value of allowed) {
    lookup.set(value.toLowerCase(), value);
  }

  const candidate = lookup.get(normalised.toLowerCase());
  return candidate;
}

/**
 * Returns a canonical enum value, defaulting to {@link defaultValue} whenever the environment
 * variable is not set or fails validation. The helper builds on {@link readOptionalEnum} so the
 * coercion logic stays consistent across required and optional call sites.
 */
export function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  return readOptionalEnum(name, allowed) ?? defaultValue;
}

// Tests previously relied on the literal sets to mirror runtime behaviour. The
// new sanitised helpers exercise the public API directly, so the extra export
// is no longer required.

