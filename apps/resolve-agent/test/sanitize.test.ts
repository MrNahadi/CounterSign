import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { type SchemaRewrite, sanitizeSchema } from "../src/sanitize";

// ADR 0014's schema sanitizer: each rewrite has a case, the input is never changed, and the gate's
// own recorded tool list passes through untouched.

const rules = (rewrites: readonly SchemaRewrite[]) => rewrites.map((r) => [r.rule, r.path]);

describe("sanitizeSchema: ADR 0014 rewrites", () => {
  it("removes $schema, $id and $comment wherever they appear", () => {
    const { schema, rewrites } = sanitizeSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:example:refund",
      type: "object",
      properties: { note: { type: "string", $comment: "free text" } },
    });
    expect(schema).toEqual({ type: "object", properties: { note: { type: "string" } } });
    expect(rules(rewrites)).toEqual([
      ["removed_keyword", "/$schema"],
      ["removed_keyword", "/$id"],
      ["removed_keyword", "/properties/note/$comment"],
    ]);
  });

  it("turns true subschemas into {} and drops false properties", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      properties: { anything: true, never: false, list: { type: "array", items: true } },
      required: ["anything"],
      additionalProperties: false,
    });
    expect(schema).toEqual({
      type: "object",
      properties: { anything: {}, list: { type: "array", items: {} } },
      required: ["anything"],
      additionalProperties: false,
    });
    expect(rules(rewrites)).toEqual([
      ["boolean_subschema", "/properties/anything"],
      ["boolean_subschema", "/properties/never"],
      ["boolean_subschema", "/properties/list/items"],
    ]);
  });

  it("turns draft-04 boolean exclusive bounds into numeric ones", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      properties: {
        amount: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 100 },
        count: { type: "integer", maximum: 10, exclusiveMaximum: true },
        loose: { type: "number", minimum: 1, exclusiveMinimum: false },
      },
    });
    expect(schema.properties).toEqual({
      amount: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      count: { type: "integer", exclusiveMaximum: 10 },
      loose: { type: "number", minimum: 1 },
    });
    expect(rules(rewrites)).toEqual([
      ["exclusive_bound", "/properties/amount/exclusiveMinimum"],
      ["exclusive_bound", "/properties/count/exclusiveMaximum"],
      ["exclusive_bound", "/properties/loose/exclusiveMinimum"],
    ]);
  });

  it("turns tuple items into prefixItems", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    });
    expect(schema.properties).toEqual({
      pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
    });
    expect(rules(rewrites)).toEqual([["tuple_items", "/properties/pair/items"]]);
  });

  it("filters required down to declared properties", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      properties: { id: { type: "string" }, gone: false },
      required: ["id", "gone", "ghost"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(rules(rewrites)).toEqual([
      ["boolean_subschema", "/properties/gone"],
      ["required_filtered", "/required"],
    ]);
  });

  it("removes a required list with no declared properties at all", () => {
    const { schema, rewrites } = sanitizeSchema({ type: "object", required: ["id"] });
    expect(schema).toEqual({ type: "object" });
    expect(rules(rewrites)).toEqual([["required_filtered", "/required"]]);
  });

  it("inlines non-recursive $refs from $defs, definitions and #/properties pointers", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      $defs: { money: { type: "object", properties: { value: { type: "string" } } } },
      definitions: { id: { type: "string", pattern: "^[A-Z0-9]+$" } },
      properties: {
        amount: { $ref: "#/$defs/money", description: "The amount." },
        capture_id: { $ref: "#/definitions/id" },
        refund_id: { $ref: "#/properties/capture_id" },
      },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        amount: {
          type: "object",
          properties: { value: { type: "string" } },
          description: "The amount.",
        },
        capture_id: { type: "string", pattern: "^[A-Z0-9]+$" },
        refund_id: { type: "string", pattern: "^[A-Z0-9]+$" },
      },
    });
    expect(rules(rewrites)).toEqual([
      ["removed_keyword", "/$defs"],
      ["removed_keyword", "/definitions"],
      ["ref_inlined", "/properties/amount"],
      ["ref_inlined", "/properties/capture_id"],
      ["ref_inlined", "/properties/refund_id"],
      ["ref_inlined", "/properties/refund_id"],
    ]);
  });

  it("replaces recursive $refs with {} and unresolvable ones too", () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      $defs: {
        node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
        },
      },
      properties: {
        tree: { $ref: "#/$defs/node" },
        self: { $ref: "#" },
        elsewhere: { $ref: "https://example.com/schema.json" },
      },
    });
    expect(schema.properties).toEqual({
      tree: {
        type: "object",
        properties: { name: { type: "string" }, children: { type: "array", items: {} } },
      },
      self: {},
      elsewhere: {},
    });
    expect(rules(rewrites)).toEqual([
      ["removed_keyword", "/$defs"],
      ["ref_inlined", "/properties/tree"],
      ["ref_recursive", "/properties/tree/properties/children/items"],
      ["ref_recursive", "/properties/self"],
      ["ref_unresolved", "/properties/elsewhere"],
    ]);
  });

  it('collapses [T, "null"] inside array items to T, and leaves it elsewhere', () => {
    const { schema, rewrites } = sanitizeSchema({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: ["object", "null"], properties: {} } },
        pair: { type: "array", prefixItems: [{ type: ["null", "string"] }] },
        note: { type: ["string", "null"] },
      },
    });
    expect(schema.properties).toEqual({
      tags: { type: "array", items: { type: "object", properties: {} } },
      pair: { type: "array", prefixItems: [{ type: "string" }] },
      note: { type: ["string", "null"] },
    });
    expect(rules(rewrites)).toEqual([
      ["nullable_items", "/properties/tags/items/type"],
      ["nullable_items", "/properties/pair/prefixItems/0/type"],
    ]);
  });

  it("adds a missing type where it can be inferred, and only there", () => {
    const { schema, rewrites } = sanitizeSchema({
      properties: {
        id: { pattern: "^[0-9]+$" },
        size: { minimum: 1 },
        list: { items: { enum: ["a", "b"] } },
        flag: { const: true },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        free: {},
      },
    });
    expect(schema).toEqual({
      properties: {
        id: { pattern: "^[0-9]+$", type: "string" },
        size: { minimum: 1, type: "number" },
        list: { items: { enum: ["a", "b"], type: "string" }, type: "array" },
        flag: { const: true, type: "boolean" },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        free: {},
      },
      type: "object",
    });
    expect(rules(rewrites)).toEqual([
      ["type_inferred", "/properties/id"],
      ["type_inferred", "/properties/size"],
      ["type_inferred", "/properties/list/items"],
      ["type_inferred", "/properties/list"],
      ["type_inferred", "/properties/flag"],
      ["type_inferred", ""],
    ]);
  });

  it("gives a missing or boolean root an object type", () => {
    expect(sanitizeSchema(true)).toEqual({
      schema: { type: "object" },
      rewrites: [
        { rule: "boolean_subschema", path: "", detail: expect.any(String) },
        { rule: "type_inferred", path: "", detail: expect.any(String) },
      ],
    });
    expect(sanitizeSchema({}).schema).toEqual({ type: "object" });
  });
});

describe("sanitizeSchema: purity", () => {
  it("never changes its input and shares no objects with it", () => {
    const input = {
      $schema: "https://json-schema.org/draft-04/schema#",
      type: "object",
      $defs: { id: { type: "string" } },
      properties: {
        id: { $ref: "#/$defs/id" },
        amount: { type: "number", minimum: 0, exclusiveMinimum: true },
        pair: { items: [{ type: "string" }, true] },
        tags: { type: "array", items: { type: ["string", "null"] }, default: ["x"] },
        gone: false,
      },
      required: ["id", "gone"],
    };
    const before = structuredClone(input);
    const { schema } = sanitizeSchema(input);
    expect(input).toEqual(before);

    const tags = (schema.properties as Record<string, { default: string[] }>).tags;
    tags.default.push("y");
    expect(input.properties.tags.default).toEqual(["x"]);
  });

  it("gives the same answer for the same input", () => {
    const input = { properties: { a: { $ref: "#/properties/b" }, b: { minimum: 0 } } };
    expect(sanitizeSchema(input)).toEqual(sanitizeSchema(input));
  });

  it("reports every rewrite with a plain detail and makes none on a clean schema", () => {
    const { rewrites } = sanitizeSchema({ $comment: "x", type: "object" });
    expect(rewrites).toEqual([
      { rule: "removed_keyword", path: "/$comment", detail: "Removed $comment." },
    ]);
    const clean = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    expect(sanitizeSchema(clean)).toEqual({ schema: clean, rewrites: [] });
  });
});

describe("sanitizeSchema on the gate's recorded tools/list", () => {
  const fixturePath = createRequire(import.meta.url).resolve(
    "@countersign/gate/test/fixtures/tools-list.json",
  );
  const { tools } = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    tools: { name: string; inputSchema: unknown }[];
  };

  it("holds the gate's fourteen tools", () => {
    expect(tools).toHaveLength(14);
  });

  it.each(tools.map((tool) => [tool.name, tool.inputSchema] as const))(
    "makes no rewrite on %s",
    (_name, inputSchema) => {
      expect(sanitizeSchema(inputSchema)).toEqual({ schema: inputSchema, rewrites: [] });
    },
  );
});
