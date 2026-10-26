/**
 * Structural validation: the document against the official JSON Schema of its
 * specification (vendored in ./schemas), plus local $ref resolution. Results
 * are Spanish diagnostics anchored to the exact key or value in the text.
 */
import { Ajv, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import { describeRoot, isObject, type DocumentSummary, type SpecFamily } from "./detect.js";
import { outlineOf, type OutlineItem } from "./outline.js";
import { checkExternalRefs, type FileReader } from "./refs.js";
import { runGuide } from "./govern/engine.js";
import type { Guide } from "./govern/guide.js";
import { loadDocument, parsePointer, pointerOf, type Diagnostic, type LoadedDocument, type Range } from "./source.js";
import oas20 from "./schemas/openapi-2.0.json" with { type: "json" };
import oas30 from "./schemas/openapi-3.0.json" with { type: "json" };
import oas31 from "./schemas/openapi-3.1.json" with { type: "json" };
import oas32 from "./schemas/openapi-3.2.json" with { type: "json" };
import async200 from "./schemas/asyncapi-2.0.0.json" with { type: "json" };
import async210 from "./schemas/asyncapi-2.1.0.json" with { type: "json" };
import async220 from "./schemas/asyncapi-2.2.0.json" with { type: "json" };
import async230 from "./schemas/asyncapi-2.3.0.json" with { type: "json" };
import async240 from "./schemas/asyncapi-2.4.0.json" with { type: "json" };
import async250 from "./schemas/asyncapi-2.5.0.json" with { type: "json" };
import async260 from "./schemas/asyncapi-2.6.0.json" with { type: "json" };
import async300 from "./schemas/asyncapi-3.0.0.json" with { type: "json" };
import async310 from "./schemas/asyncapi-3.1.0.json" with { type: "json" };

type Draft = "04" | "07" | "2020";
interface SchemaEntry {
  /** Shown to the user: which official schema was applied. */
  label: string;
  draft: Draft;
  schema: object;
}

const OPENAPI: Record<Exclude<SpecFamily, "asyncapi-2" | "asyncapi-3">, SchemaEntry> = {
  "swagger-2.0": { label: "Swagger 2.0 (2017-08-27)", draft: "04", schema: oas20 },
  "openapi-3.0": { label: "OpenAPI 3.0 (2024-10-18)", draft: "04", schema: oas30 },
  "openapi-3.1": { label: "OpenAPI 3.1 (2026-08-03)", draft: "2020", schema: oas31 },
  "openapi-3.2": { label: "OpenAPI 3.2 (2026-08-30)", draft: "2020", schema: oas32 },
};

const ASYNCAPI: Record<string, object> = {
  "2.0.0": async200,
  "2.1.0": async210,
  "2.2.0": async220,
  "2.3.0": async230,
  "2.4.0": async240,
  "2.5.0": async250,
  "2.6.0": async260,
  "3.0.0": async300,
  "3.1.0": async310,
};

/** Never more than this many diagnostics per document: past that they only bury the first ones. */
export const MAX_DIAGNOSTICS = 500;

const validators = new Map<string, ValidateFunction>();

// CommonJS default exports reach ESM either as the module or as its "default" member; TypeScript sees the module.
// Declared by shape so both NodeNext (CLI) and Bundler (desktop) resolution agree.
type Draft04Class = new (options: Options) => Ajv;
type AddFormats = (ajv: Ajv) => Ajv;
const Draft04: Draft04Class = (AjvDraft04 as unknown as { default?: Draft04Class }).default ?? (AjvDraft04 as unknown as Draft04Class);
const withFormats: AddFormats = (addFormats as unknown as { default?: AddFormats }).default ?? (addFormats as unknown as AddFormats);

/**
 * The OpenAPI 3.1/3.2 schemas reach Schema Objects through "$dynamicRef: #meta",
 * which ajv does not resolve to a $dynamicAnchor inside $defs. Point those at the
 * anchored definition with a plain $ref instead: same meaning for these schemas.
 */
export function inlineDynamicRefs(schema: object): object {
  const defs = (schema as { $defs?: Record<string, { $dynamicAnchor?: string }> }).$defs ?? {};
  const anchors = new Map(Object.entries(defs).flatMap(([name, def]) => (def.$dynamicAnchor ? [[`#${def.$dynamicAnchor}`, `#/$defs/${name}`]] : [])));
  const copy = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(copy);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => (k === "$dynamicRef" && typeof v === "string" && anchors.has(v) ? ["$ref", anchors.get(v)] : [k, copy(v)])),
    );
  };
  return copy(schema) as object;
}

const prepared = new Map<string, object>();

/** The schema as Specix uses it (3.1/3.2 with dynamic references inlined), cached. */
function preparedSchema(key: string, entry: { draft: Draft; schema: object }): object {
  let schema = prepared.get(key);
  if (!schema) {
    schema = entry.draft === "2020" ? inlineDynamicRefs(entry.schema) : entry.schema;
    prepared.set(key, schema);
  }
  return schema;
}

/** Official schema for a specification version, ready for the editor's language service. */
export function schemaDocumentFor(family: SpecFamily, specVersion: string): object {
  const { key, entry } = schemaFor(family, specVersion);
  return preparedSchema(key, entry);
}

function validatorFor(key: string, entry: { draft: Draft; schema: object }): ValidateFunction {
  const cached = validators.get(key);
  if (cached) return cached;
  // validateSchema off: these are the published schemas, and checking them against their meta-schema only costs time.
  // The AsyncAPI bundles embed their own copy of the draft-07 meta-schema, which would clash with ajv's (meta: false).
  const options: Options = { strict: false, allErrors: true, validateSchema: false, allowUnionTypes: true, logger: false, meta: entry.draft !== "07" };
  const ajv = entry.draft === "04" ? new Draft04(options) : entry.draft === "2020" ? new Ajv2020(options) : new Ajv(options);
  withFormats(ajv as unknown as Ajv);
  const validate = ajv.compile(preparedSchema(key, entry));
  validators.set(key, validate);
  return validate;
}

/** Picks the official schema for a document, or explains why there is none. */
export function schemaFor(family: SpecFamily, specVersion: string): { key: string; entry: SchemaEntry; note: string | null } {
  if (family !== "asyncapi-2" && family !== "asyncapi-3") return { key: family, entry: OPENAPI[family], note: null };
  const exact = ASYNCAPI[specVersion.split("-")[0]!];
  if (exact) return { key: `asyncapi-${specVersion}`, entry: { label: `AsyncAPI ${specVersion}`, draft: "07", schema: exact }, note: null };
  const major = family === "asyncapi-2" ? "2." : "3.";
  const latest = Object.keys(ASYNCAPI).filter((v) => v.startsWith(major)).sort().at(-1)!;
  return {
    key: `asyncapi-${latest}`,
    entry: { label: `AsyncAPI ${latest}`, draft: "07", schema: ASYNCAPI[latest]! },
    note: `No hay esquema oficial para AsyncAPI ${specVersion}; se valida con el de ${latest}`,
  };
}

const TYPE_NAMES: Record<string, string> = {
  string: "texto",
  number: "un número",
  integer: "un entero",
  boolean: "verdadero o falso",
  object: "un objeto",
  array: "una lista",
  null: "nulo",
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function valueAt(root: unknown, pointer: string): unknown {
  let node = root;
  for (const segment of parsePointer(pointer)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const list = (values: unknown[], max = 8) =>
  values.slice(0, max).map((v) => `«${String(v)}»`).join(", ") + (values.length > max ? ` y ${values.length - max} más` : "");

interface Located {
  pointer: string;
  part: "key" | "value";
  code: string;
  message: string;
}

/** Turns one ajv error into a Spanish message pointing at the right node. */
function describe(e: ErrorObject, root: unknown): Located {
  const p = e.params as Record<string, unknown>;
  const at = (part: "key" | "value", extra?: string): Pick<Located, "pointer" | "part"> => ({
    pointer: extra === undefined ? e.instancePath : `${e.instancePath}${pointerOf([extra])}`,
    part,
  });
  const code = `schema/${e.keyword}`;
  switch (e.keyword) {
    case "required":
      return { ...at("key"), code, message: `Falta la propiedad obligatoria «${String(p["missingProperty"])}»` };
    case "additionalProperties":
    case "unevaluatedProperties": {
      const name = String(p["additionalProperty"] ?? p["unevaluatedProperty"]);
      const hint =
        e.instancePath === "/paths" ? ": las rutas deben empezar por «/»" : name.startsWith("x") ? "" : "; las extensiones propias empiezan por «x-»";
      return { ...at("key", name), code, message: `Propiedad no permitida aquí: «${name}»${hint}` };
    }
    case "propertyNames":
      return { ...at("key", String(p["propertyName"])), code, message: `Nombre de propiedad no válido: «${String(p["propertyName"])}»` };
    case "type": {
      const expected = String(p["type"]).split(",").map((t) => TYPE_NAMES[t] ?? t).join(" o ");
      const actual = TYPE_NAMES[typeOf(valueAt(root, e.instancePath))] ?? "otro tipo";
      return { ...at("value"), code, message: `Se esperaba ${expected} y hay ${actual}` };
    }
    case "enum":
      return { ...at("value"), code, message: `Valor no permitido; usa uno de: ${list(p["allowedValues"] as unknown[])}` };
    case "const":
      return { ...at("value"), code, message: `Debe ser «${String(p["allowedValue"])}»` };
    case "pattern":
      return { ...at("value"), code, message: `No tiene el formato esperado (${String(p["pattern"])})` };
    case "format":
      return { ...at("value"), code, message: `No es un valor de tipo «${String(p["format"])}» válido` };
    case "minItems":
      return { ...at("value"), code, message: `Necesita al menos ${String(p["limit"])} elemento${p["limit"] === 1 ? "" : "s"}` };
    case "maxItems":
      return { ...at("value"), code, message: `Admite como máximo ${String(p["limit"])} elementos` };
    case "minProperties":
      return { ...at("value"), code, message: `Necesita al menos ${String(p["limit"])} propiedad${p["limit"] === 1 ? "" : "es"}` };
    case "minLength":
      return { ...at("value"), code, message: p["limit"] === 1 ? "No puede estar vacío" : `Necesita al menos ${String(p["limit"])} caracteres` };
    case "maxLength":
      return { ...at("value"), code, message: `Admite como máximo ${String(p["limit"])} caracteres` };
    case "minimum":
    case "exclusiveMinimum":
    case "maximum":
    case "exclusiveMaximum": {
      const words = { minimum: "mayor o igual que", exclusiveMinimum: "mayor que", maximum: "menor o igual que", exclusiveMaximum: "menor que" } as const;
      return { ...at("value"), code, message: `Debe ser ${words[e.keyword]} ${String(p["limit"])}` };
    }
    case "uniqueItems":
      return { ...at("value"), code, message: "La lista tiene elementos repetidos" };
    case "dependencies":
    case "dependentRequired":
      return { ...at("key"), code, message: `Si está «${String(p["property"])}», también debe estar «${String(p["missingProperty"])}»` };
    case "requiredOneOf": {
      const missing = (p["missing"] as string[]).map((m) => `«${m}»`);
      return { ...at("key"), code: "schema/required", message: `Falta una de estas propiedades: ${missing.slice(0, -1).join(", ")} o ${missing.at(-1)}` };
    }
    case "oneOf":
      return p["passingSchemas"]
        ? { ...at("value"), code, message: "Encaja en más de una de las formas permitidas; debe encajar solo en una" }
        : { ...at("value"), code, message: "No encaja en ninguna de las formas permitidas aquí" };
    case "anyOf":
      return { ...at("value"), code, message: "No encaja en ninguna de las formas permitidas aquí" };
    case "not":
      return { ...at("value"), code, message: "Este valor no está permitido aquí" };
    default:
      return { ...at("value"), code, message: e.message ? `No cumple el esquema: ${e.message}` : "No cumple el esquema" };
  }
}

/** Properties the specifications ask for one of, never all of. */
const ALTERNATIVES = [
  ["schema", "content"],
  ["paths", "components", "webhooks"],
  ["value", "externalValue", "dataValue", "serializedValue"],
];

const isComposite = (e: ErrorObject) => e.keyword === "oneOf" || e.keyword === "anyOf";
const under = (path: string, ancestor: string) => path === ancestor || path.startsWith(`${ancestor}/`);

/**
 * ajv reports every alternative of a oneOf/anyOf that failed, which buries the
 * real problem; and after a $ref its schemaPath restarts, so branches cannot be
 * told apart by schema path. These rules work on the document path instead:
 * - if/then/else and "missing $ref" (the Reference Object alternative) are noise;
 * - enum and const errors on the same value merge into one list of allowed values;
 * - several "required" at a node with nothing more precise below it are
 *   alternatives ("one of these"), not all mandatory;
 * - a oneOf/anyOf error is dropped when a more precise error exists at or below it.
 */
export function reduceErrors(errors: readonly ErrorObject[]): ErrorObject[] {
  let kept = errors.filter(
    (e) => !["if", "then", "else"].includes(e.keyword) && !(e.keyword === "required" && (e.params as { missingProperty?: string }).missingProperty === "$ref"),
  );

  // Alternatives that each allow a different value: one message with all of them.
  const merged: ErrorObject[] = [];
  const allowedAt = new Map<string, ErrorObject>();
  for (const e of kept) {
    if (e.keyword !== "enum" && e.keyword !== "const") {
      merged.push(e);
      continue;
    }
    const values = e.keyword === "enum" ? ((e.params as { allowedValues: unknown[] }).allowedValues ?? []) : [(e.params as { allowedValue: unknown }).allowedValue];
    const existing = allowedAt.get(e.instancePath);
    if (existing) {
      const all = (existing.params as { allowedValues: unknown[] }).allowedValues;
      for (const v of values) if (!all.includes(v)) all.push(v);
    } else {
      const combined: ErrorObject = { ...e, keyword: "enum", params: { allowedValues: [...values] } };
      allowedAt.set(e.instancePath, combined);
      merged.push(combined);
    }
  }
  kept = merged;

  const composites = kept.filter(isComposite);
  const specific = kept.filter((e) => !isComposite(e));
  const result: ErrorObject[] = [];
  const consumed = new Set<ErrorObject>();
  for (const composite of composites) {
    const at = composite.instancePath;
    const below = specific.filter((e) => under(e.instancePath, at));
    const deeper = below.filter((e) => e.instancePath !== at);
    const required = below.filter((e) => e.instancePath === at && e.keyword === "required" && !consumed.has(e));
    const missingOf = (e: ErrorObject) => String((e.params as { missingProperty: string }).missingProperty);
    // Known either/or pairs merge even when other problems sit deeper in the same node.
    const alternatives = ALTERNATIVES.map((group) => required.filter((e) => group.includes(missingOf(e)))).find((hits) => hits.length >= 2);
    const group = alternatives ?? (deeper.length === 0 && required.length >= 2 && below.every((e) => e.keyword === "required") ? required : null);
    if (group) {
      result.push({ ...composite, keyword: "requiredOneOf", params: { missing: [...new Set(group.map(missingOf))] } });
      group.forEach((e) => consumed.add(e));
    } else if (below.length === 0 && !result.some((r) => isComposite(r) && r.instancePath === at)) {
      result.push(composite);
    }
  }
  return [...specific.filter((e) => !consumed.has(e)), ...result];
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Closest name to a misspelt one, if it is close enough to be a likely typo. */
export function suggest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  // A guess that rewrites most of a short name is not a typo fix.
  return best !== null && bestDistance < name.length && bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

/** Every local "#/…" $ref must point at something in the same document (refs.ts checks the ones to other files). */
function checkLocalRefs(root: unknown, doc: LoadedDocument): Diagnostic[] {
  const found: Diagnostic[] = [];
  const walk = (node: unknown, segments: Array<string | number>) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, [...segments, i]));
    if (!isObject(node)) return;
    const ref = node["$ref"];
    if (typeof ref === "string" && ref.startsWith("#")) {
      let target: string | null = null;
      try {
        target = decodeURIComponent(ref.slice(1));
      } catch {
        target = null;
      }
      const pointer = pointerOf([...segments, "$ref"]);
      if (target === null || (target !== "" && !target.startsWith("/"))) {
        found.push({ severity: "error", code: "ref/invalid", message: `Referencia mal escrita: «${ref}»`, source: "referencias", pointer, range: doc.locate(pointer) });
      } else if (valueAt(root, target) === undefined) {
        const parts = parsePointer(target);
        const parent = valueAt(root, pointerOf(parts.slice(0, -1)));
        const guess = isObject(parent) ? suggest(parts.at(-1) ?? "", Object.keys(parent)) : null;
        found.push({
          severity: "error",
          code: "ref/missing",
          message: `La referencia «${ref}» no existe${guess ? `. ¿Querías «${guess}»?` : ""}`,
          source: "referencias",
          pointer,
          range: doc.locate(pointer),
        });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      // Examples and extensions are free-form data: a "$ref" inside them is just text.
      if (key === "example" || key.startsWith("x-")) continue;
      walk(value, [...segments, key]);
    }
  };
  walk(root, []);
  return found;
}

export interface Analysis extends Omit<DocumentSummary, "problems"> {
  /** Official schema applied, e.g. "OpenAPI 3.1 (2026-08-03)"; null when none could be. */
  schema: string | null;
  diagnostics: Diagnostic[];
  /** Operations, channels and components, for the editor's outline. */
  outline: OutlineItem[];
  /** The style guide applied, if any: its name, how many rules ran, and problems reading it. */
  guide: { name: string; rulesRun: number; problems: string[] } | null;
}

const byPosition = (a: Diagnostic, b: Diagnostic) => a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column;

export interface AnalyzeOptions {
  /** Absolute path of the document, so references to other files can be checked. */
  file?: string;
  reader?: FileReader;
  /**
   * The file is part of a multi-file definition (a path item, a set of schemas…),
   * not its entry: there is no "openapi:" to look for, so only syntax and
   * references are checked.
   */
  fragment?: boolean;
  /** Style guide to apply after the structural checks (S5 governance). */
  guide?: Guide;
}

/** Full structural check of one document: syntax, specification, official schema and references. */
export function analyzeDocument(source: string, options: AnalyzeOptions = {}): Analysis {
  const doc = loadDocument(source);
  const external = (root: unknown) => (options.file && options.reader ? checkExternalRefs(root, doc, options.file, options.reader) : []);
  const base: Analysis = { format: doc.format, family: null, specVersion: null, title: null, apiVersion: null, operations: 0, schema: null, diagnostics: [], outline: [], guide: null };
  if (doc.diagnostics.length) return { ...base, diagnostics: doc.diagnostics };

  const root = doc.value;
  const whole: Range = doc.locate("");
  if (!isObject(root)) {
    return { ...base, diagnostics: [{ severity: "error", code: "doc/not-object", message: "La raíz del documento debe ser un objeto", source: "estructura", pointer: "", range: whole }] };
  }

  const { problem, ...described } = describeRoot(root);
  const result: Analysis = { ...base, ...described, outline: outlineOf(doc) };
  if (options.fragment && !described.family) {
    return { ...result, diagnostics: [...checkLocalRefs(root, doc), ...external(root)].sort(byPosition).slice(0, MAX_DIAGNOSTICS) };
  }
  if (problem || !described.family || !described.specVersion) {
    const p = problem ?? { code: "spec/not-an-api", message: "No es una definición de API", pointer: "" };
    return { ...result, diagnostics: [{ severity: "error", code: p.code, message: p.message, source: "estructura", pointer: p.pointer, range: doc.locate(p.pointer) }] };
  }

  const { key, entry, note } = schemaFor(described.family, described.specVersion);
  const validate = validatorFor(key, entry);
  validate(root);
  const located = reduceErrors(validate.errors ?? []).map((e) => describe(e, root));
  // The fallback schema pins its own version number: that mismatch is already explained by the note.
  const relevant = note ? located.filter((l) => l.pointer !== "/asyncapi") : located;
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const l of relevant) {
    const id = `${l.pointer}\u0000${l.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    diagnostics.push({ severity: "error", code: l.code, message: l.message, source: "estructura", pointer: l.pointer, range: doc.locate(l.pointer, l.part) });
  }
  if (note) diagnostics.push({ severity: "info", code: "spec/schema-fallback", message: note, source: "estructura", pointer: "/asyncapi", range: doc.locate("/asyncapi") });
  diagnostics.push(...checkLocalRefs(root, doc), ...external(root));
  let guide: Analysis["guide"] = null;
  if (options.guide) {
    const run = runGuide(options.guide, doc, described.family);
    diagnostics.push(...run.diagnostics);
    guide = { name: options.guide.name, rulesRun: run.rulesRun, problems: options.guide.problems.map((p) => p.message) };
  }

  return { ...result, schema: entry.label, guide, diagnostics: diagnostics.sort(byPosition).slice(0, MAX_DIAGNOSTICS) };
}
