import { describe, expect, it } from "vitest";
import { canonicalJson, type JsonValue } from "../src/index";

// Characters built from code points, so the expected text doesn't depend on source escapes.
const ch = (...codeUnits: number[]) => String.fromCharCode(...codeUnits);
const BS = ch(0x5c);
const EURO = ch(0x20ac);

describe("canonicalJson", () => {
  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)", () => {
    const input = {
      [EURO]: "Euro Sign",
      [ch(0x0d)]: "Carriage Return",
      [ch(0xfb33)]: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [ch(0xd83d, 0xde00)]: "Emoji: Grinning Face",
      [ch(0x80)]: "Control",
      [ch(0xf6)]: "Latin Small Letter O With Diaeresis",
    };
    const expected = [
      `"${BS}r":"Carriage Return"`,
      `"1":"One"`,
      `"${ch(0x80)}":"Control"`,
      `"${ch(0xf6)}":"Latin Small Letter O With Diaeresis"`,
      `"${EURO}":"Euro Sign"`,
      `"${ch(0xd83d, 0xde00)}":"Emoji: Grinning Face"`,
      `"${ch(0xfb33)}":"Hebrew Letter Dalet With Dagesh"`,
    ];
    expect(canonicalJson(input)).toBe(`{${expected.join(",")}}`);
  });

  it("escapes strings and writes literals as RFC 8785 section 3.2.2 does", () => {
    // The RFC's example "string" property, decoded.
    const string = `${EURO}$${ch(0x0f, 0x0a)}A'B"${BS}${BS}"/`;
    const input = { string, literals: [null, true, false] };
    // The RFC's expected serialization of that property.
    const escaped = `${EURO}$${BS}u000f${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/`;
    expect(canonicalJson(input)).toBe(`{"literals":[null,true,false],"string":"${escaped}"}`);
  });

  it("uses the short escapes for the JSON control characters and \\u for the rest", () => {
    const input = ch(0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x00, 0x1f, 0x7f);
    const expected = `"${BS}b${BS}t${BS}n${BS}f${BS}r${BS}u0000${BS}u001f${ch(0x7f)}"`;
    expect(canonicalJson(input)).toBe(expected);
  });

  it("writes nested values with no whitespace and safe integers as digits", () => {
    const input = { b: [1, { d: -2, c: [] }], a: { z: 9007199254740991, y: {} } };
    expect(canonicalJson(input)).toBe(
      '{"a":{"y":{},"z":9007199254740991},"b":[1,{"c":[],"d":-2}]}',
    );
  });

  it("gives the same text whatever the key order", () => {
    expect(canonicalJson({ x: 1, y: { p: "a", q: "b" } })).toBe(
      canonicalJson({ y: { q: "b", p: "a" }, x: 1 }),
    );
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    ["a nested fraction", { amount: [0.1] }],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalJson(value as JsonValue)).toThrow();
  });

  it.each([
    ["undefined", undefined],
    ["an undefined property", { a: undefined }],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a date", new Date(0)],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    ["a sparse array", [, 1]],
    ["a lone surrogate", ch(0xd800)],
    ["a lone surrogate in a key", { [ch(0xdc00)]: 1 }],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalJson(value as unknown as JsonValue)).toThrow();
  });
});
