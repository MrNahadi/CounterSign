// ADR 0014's schema sanitizer: turns any MCP tool's `inputSchema` into a JSON Schema Gemini accepts
// as `parametersJsonSchema`. It rewrites only what the model sees; the gate (zod 4) and PayPal's
// server stay the authority on arguments. Pure: the input is never changed, and the output shares
// no objects with it. The same function runs in both modes, so the baseline isn't tuned to fail.

export const SCHEMA_REWRITE_RULES = [
  "removed_keyword",
  "boolean_subschema",
  "exclusive_bound",
  "tuple_items",
  "required_filtered",
  "ref_inlined",
  "ref_recursive",
  "ref_unresolved",
  "nullable_items",
  "type_inferred",
] as const;

export type SchemaRewriteRule = (typeof SCHEMA_REWRITE_RULES)[number];

/** One change the sanitizer made. `path` is a JSON Pointer into the sanitized schema. */
export type SchemaRewrite = { rule: SchemaRewriteRule; path: string; detail: string };

export type JsonSchemaObject = Record<string, unknown>;

export type SanitizedSchema = { schema: JsonSchemaObject; rewrites: SchemaRewrite[] };

// Keywords that are dropped wherever they appear. `$defs` and `definitions` only serve `$ref`s,
// which are all inlined or replaced.
const REMOVED = new Set(["$schema", "$id", "$comment", "$defs", "definitions"]);

// Keywords whose value is a map of name to subschema.
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas"]);

// Keywords whose value is a list of subschemas.
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

// Keywords whose value is one subschema. A boolean here is rewritten.
const SINGLE_SCHEMAS = new Set([
  "items",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
]);

// Keywords whose boolean value is ordinary JSON Schema that Gemini accepts, so it's kept.
const BOOLEAN_OK = new Set(["additionalProperties", "unevaluatedProperties", "unevaluatedItems"]);

const isObject = (value: unknown): value is JsonSchemaObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapePointer = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");
const child = (path: string, token: string | number) => `${path}/${escapePointer(String(token))}`;

// Resolves a local `$ref` (`#`, `#/$defs/…`, `#/definitions/…`, `#/properties/…`) against the
// original root. Returns the target's pointer and value, or null when it can't be resolved.
function resolveRef(root: unknown, ref: string): { pointer: string; target: unknown } | null {
  if (!ref.startsWith("#")) return null;
  let fragment: string;
  try {
    fragment = decodeURIComponent(ref.slice(1));
  } catch {
    return null;
  }
  if (fragment !== "" && !fragment.startsWith("/")) return null;
  let target: unknown = root;
  for (const raw of fragment === "" ? [] : fragment.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(target) && /^(0|[1-9][0-9]*)$/.test(token)) target = target[Number(token)];
    else if (isObject(target) && Object.hasOwn(target, token)) target = target[token];
    else return null;
    if (target === undefined) return null;
  }
  return { pointer: fragment, target };
}

function inferType(schema: JsonSchemaObject): string | null {
  if ("anyOf" in schema || "oneOf" in schema || "allOf" in schema || "not" in schema) return null;
  const has = (...keys: string[]) => keys.some((key) => key in schema);
  if (has("properties", "required", "additionalProperties", "patternProperties")) return "object";
  if (has("items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains"))
    return "array";
  if (has("minLength", "maxLength", "pattern", "format")) return "string";
  if (has("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")) {
    return "number";
  }
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : [];
  if (values.length === 0) return null;
  const kinds = new Set(values.map((value) => (value === null ? "null" : typeof value)));
  if (kinds.size !== 1) return null;
  const [kind] = kinds;
  return kind === "string" || kind === "boolean" || kind === "number" ? kind : null;
}

class Sanitizer {
  readonly rewrites: SchemaRewrite[] = [];
  // Document pointers of the original schemas being walked, innermost last. A `$ref` to one of
  // these, or to an ancestor of one, would expand forever.
  private readonly active: string[] = [];

  private readonly root: unknown;

  constructor(root: unknown) {
    this.root = root;
  }

  private note(rule: SchemaRewriteRule, path: string, detail: string) {
    this.rewrites.push({ rule, path, detail });
  }

  /** Sanitizes one subschema. `origin` is its pointer in the original document. */
  schema(value: unknown, path: string, origin: string): JsonSchemaObject {
    if (value === true || value === false || !isObject(value)) {
      this.note("boolean_subschema", path, `Replaced ${JSON.stringify(value)} with {}.`);
      return {};
    }
    this.active.push(origin);
    try {
      return this.object(value, path, origin);
    } finally {
      this.active.pop();
    }
  }

  private object(node: JsonSchemaObject, path: string, origin: string): JsonSchemaObject {
    if (typeof node.$ref === "string") return this.ref(node, node.$ref, path);

    const out: JsonSchemaObject = {};
    for (const [key, value] of Object.entries(node)) {
      const at = child(path, key);
      const from = child(origin, key);
      if (REMOVED.has(key)) {
        this.note("removed_keyword", at, `Removed ${key}.`);
      } else if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
        this.exclusive(node, key, value, out, at);
      } else if ((key === "minimum" || key === "maximum") && this.boundMovedFrom(node, key)) {
        // Becomes the numeric exclusive bound; written there.
      } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
        out[key] = this.map(key, value, at, from);
      } else if (key === "items" && Array.isArray(value)) {
        this.note("tuple_items", at, "Turned tuple items into prefixItems.");
        out.prefixItems = this.list("prefixItems", value, child(path, "prefixItems"), from);
      } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
        out[key] = this.list(key, value, at, from);
      } else if (SINGLE_SCHEMAS.has(key) && typeof value === "boolean") {
        if (value) out[key] = this.schema(value, at, from);
        else this.note("boolean_subschema", at, `Removed ${key}: false.`);
      } else if (SINGLE_SCHEMAS.has(key) && isObject(value)) {
        out[key] = this.schema(value, at, from);
        if (key === "items") this.nullableItem(out[key] as JsonSchemaObject, at);
      } else if (BOOLEAN_OK.has(key) && isObject(value)) {
        out[key] = this.schema(value, at, from);
      } else {
        out[key] = structuredClone(value);
      }
    }

    if (Array.isArray(out.required)) this.required(out, path);
    if (!("type" in out)) {
      const inferred = inferType(out) ?? (path === "" ? "object" : null);
      if (inferred !== null) {
        out.type = inferred;
        this.note("type_inferred", path, `Added type ${inferred}.`);
      }
    }
    return out;
  }

  private ref(node: JsonSchemaObject, ref: string, path: string): JsonSchemaObject {
    const resolved = resolveRef(this.root, ref);
    if (resolved === null) {
      this.note("ref_unresolved", path, `Replaced unresolvable $ref ${ref} with {}.`);
      return {};
    }
    const { pointer, target } = resolved;
    const recursive = this.active.some((o) => o === pointer || o.startsWith(`${pointer}/`));
    if (recursive) {
      this.note("ref_recursive", path, `Replaced recursive $ref ${ref} with {}.`);
      return {};
    }
    this.note("ref_inlined", path, `Inlined $ref ${ref}.`);
    const { $ref: _ref, ...siblings } = node;
    // Keywords beside the `$ref` (a description, say) override the target's.
    const merged = isObject(target) ? { ...target, ...siblings } : target;
    return this.schema(merged, path, pointer);
  }

  private map(key: string, value: JsonSchemaObject, at: string, from: string) {
    const out: JsonSchemaObject = {};
    for (const [name, sub] of Object.entries(value)) {
      if (sub === false && key === "properties") {
        this.note("boolean_subschema", child(at, name), `Removed property ${name}: false.`);
        continue;
      }
      out[name] = this.schema(sub, child(at, name), child(from, name));
    }
    return out;
  }

  private list(key: string, value: unknown[], at: string, from: string) {
    const out: JsonSchemaObject[] = [];
    value.forEach((sub, index) => {
      if (sub === false && key !== "prefixItems") {
        this.note("boolean_subschema", child(at, index), `Removed false from ${key}.`);
        return;
      }
      const position = child(at, out.length);
      const result = this.schema(sub, position, child(from, index));
      if (key === "prefixItems") this.nullableItem(result, position);
      out.push(result);
    });
    return out;
  }

  // Draft-04 `exclusiveMinimum: true` with `minimum: n` becomes `exclusiveMinimum: n`.
  private boundMovedFrom(node: JsonSchemaObject, key: "minimum" | "maximum") {
    const flag = key === "minimum" ? node.exclusiveMinimum : node.exclusiveMaximum;
    return flag === true && typeof node[key] === "number";
  }

  private exclusive(
    node: JsonSchemaObject,
    key: "exclusiveMinimum" | "exclusiveMaximum",
    value: unknown,
    out: JsonSchemaObject,
    at: string,
  ) {
    if (typeof value !== "boolean") {
      out[key] = structuredClone(value);
      return;
    }
    const bound = node[key === "exclusiveMinimum" ? "minimum" : "maximum"];
    if (value && typeof bound === "number") {
      out[key] = bound;
      this.note("exclusive_bound", at, `Turned ${key}: true into ${key}: ${bound}.`);
    } else {
      this.note("exclusive_bound", at, `Removed boolean ${key}: ${value}.`);
    }
  }

  private required(out: JsonSchemaObject, path: string) {
    const declared = isObject(out.properties) ? out.properties : {};
    const required = out.required as unknown[];
    const kept = required.filter(
      (name) => typeof name === "string" && Object.hasOwn(declared, name),
    );
    if (kept.length === required.length) return;
    const at = child(path, "required");
    if (kept.length === 0) {
      delete out.required;
      this.note("required_filtered", at, "Removed required: no listed property is declared.");
    } else {
      out.required = kept;
      this.note("required_filtered", at, "Kept only the declared properties in required.");
    }
  }

  // `type: [T, "null"]` inside array items becomes `T`.
  private nullableItem(item: JsonSchemaObject, at: string) {
    const { type } = item;
    if (!Array.isArray(type) || type.length !== 2 || !type.includes("null")) return;
    const other = type.find((t) => t !== "null");
    if (typeof other !== "string") return;
    item.type = other;
    this.note("nullable_items", child(at, "type"), `Collapsed [${other}, null] to ${other}.`);
  }
}

/** Sanitizes one MCP tool's `inputSchema` for Gemini and reports each rewrite it made. */
export function sanitizeSchema(inputSchema: unknown): SanitizedSchema {
  const sanitizer = new Sanitizer(inputSchema);
  const schema = sanitizer.schema(inputSchema, "", "");
  // Gemini's parameters are always an object. A non-object root has already been reported.
  if (!isObject(inputSchema)) {
    schema.type = "object";
    sanitizer.rewrites.push({ rule: "type_inferred", path: "", detail: "Added type object." });
  }
  return { schema, rewrites: sanitizer.rewrites };
}
