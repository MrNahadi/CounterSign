// RFC 8785 (JCS) canonical JSON for the values we hash (ADR 0019). Numbers are safe integers
// only, because money is always integer minor units; anything else is rejected, not serialized.

import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function serializeString(value: string): string {
  // I-JSON (RFC 7493), which RFC 8785 requires, forbids lone surrogates.
  if (!value.isWellFormed()) throw new TypeError("Canonical JSON can't hold a lone surrogate");
  // ECMAScript's JSON string serialization is the one RFC 8785 section 3.2.2.2 specifies.
  return JSON.stringify(value);
}

function isPlainObject(value: object): value is { [key: string]: JsonValue } {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`Canonical JSON holds safe integers only, not ${value}`);
      }
      return String(value);
    case "string":
      return serializeString(value);
    case "object": {
      // Array.from visits holes as undefined, so a sparse array is rejected like undefined.
      if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
      if (!isPlainObject(value)) throw new TypeError("Canonical JSON holds plain objects only");
      // The default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
      const members = Object.keys(value)
        .sort()
        .map((key) => `${serializeString(key)}:${canonicalJson(value[key] as JsonValue)}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`Canonical JSON can't hold a ${typeof value}`);
  }
}

// SHA-256, as hex, of a value's canonical JSON. The intent and mandate hashes both use it.
export function sha256Canonical(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
