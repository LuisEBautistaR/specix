/**
 * Style guides (governance rules) in the Spectral ruleset format, the subset
 * Specix supports: extends, rules with given (JSONPath), then (field,
 * function, functionOptions), severity, message, description and formats,
 * plus severity overrides of inherited rules. A guide that uses something
 * outside the subset is reported, never silently ignored.
 */
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { SpecFamily } from "../detect.js";
import type { FileReader } from "../refs.js";
import { loadDocument, pointerOf, type Diagnostic } from "../source.js";
import { FUNCTIONS } from "./functions.js";
import { BUILTIN_GUIDES } from "./builtin.js";

export type RuleSeverity = "error" | "warning" | "info" | "hint";

export interface Rule {
  name: string;
  description: string | null;
  message: string | null;
  severity: RuleSeverity | "off";
  given: string[];
  then: Array<{ field: string | null; function: string; functionOptions: Record<string, unknown> }>;
  formats: string[] | null;
  /** Guide the rule was defined in (its file or built-in name). */
  origin: string;
}

export interface Guide {
  /** File or built-in name ("specix:base"). */
  name: string;
  rules: Rule[];
  /** Problems found while reading the guide (and the guides it extends). */
  problems: Array<{ guide: string; message: string }>;
}

const SEVERITIES: Record<string, RuleSeverity | "off"> = { error: "error", warn: "warning", warning: "warning", info: "info", information: "info", hint: "hint", off: "off", "0": "error", "1": "warning", "2": "info", "3": "hint", "-1": "off" };

const thenSchema = z.object({
  field: z.string().optional(),
  function: z.string().min(1),
  functionOptions: z.record(z.string(), z.unknown()).optional(),
});

const ruleSchema = z.object({
  description: z.string().optional(),
  message: z.string().optional(),
  severity: z.union([z.string(), z.number()]).optional(),
  given: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  then: z.union([thenSchema, z.array(thenSchema).min(1)]),
  formats: z.array(z.string()).optional(),
  recommended: z.boolean().optional(),
  resolved: z.boolean().optional(),
});

const guideSchema = z.object({
  extends: z.union([z.string(), z.array(z.union([z.string(), z.tuple([z.string(), z.string()])]))]).optional(),
  rules: z.record(z.string(), z.union([ruleSchema, z.string(), z.number(), z.boolean()])).optional(),
  description: z.string().optional(),
  documentationUrl: z.string().optional(),
});

export const FORMAT_NAMES = ["oas2", "oas3", "oas3_0", "oas3_1", "oas3_2", "asyncapi2", "asyncapi3"] as const;

/** Spectral-style format names that apply to a document family. */
export function formatsOf(family: SpecFamily | null): string[] {
  switch (family) {
    case "swagger-2.0":
      return ["oas2"];
    case "openapi-3.0":
      return ["oas3", "oas3_0"];
    case "openapi-3.1":
      return ["oas3", "oas3_1"];
    case "openapi-3.2":
      return ["oas3", "oas3_2"];
    case "asyncapi-2":
      return ["asyncapi2"];
    case "asyncapi-3":
      return ["asyncapi3"];
    default:
      return [];
  }
}

function severityOf(raw: unknown, fallback: RuleSeverity | "off"): RuleSeverity | "off" | null {
  if (raw === undefined) return fallback;
  if (raw === true) return fallback === "off" ? "warning" : fallback;
  if (raw === false) return "off";
  return SEVERITIES[String(raw).toLowerCase()] ?? null;
}

/** Diagnostics for a guide file, so the editor can show them like any other problem. */
export function checkGuideText(text: string): Diagnostic[] {
  const doc = loadDocument(text);
  if (doc.diagnostics.length) return doc.diagnostics;
  const parsed = guideSchema.safeParse(doc.value ?? {});
  const out: Diagnostic[] = [];
  const add = (pointer: string, message: string, code = "guide/invalid") =>
    out.push({ severity: "error", code, message, source: "estructura", pointer, range: doc.locate(pointer, "key") });
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) add(pointerOf(issue.path.map(String)), `La guía no es válida aquí: ${issue.message}`);
    return out;
  }
  for (const [name, rule] of Object.entries(parsed.data.rules ?? {})) {
    if (typeof rule !== "object") {
      if (severityOf(rule, "warning") === null) add(pointerOf(["rules", name]), `Severidad desconocida «${String(rule)}»: usa error, warn, info, hint u off`);
      continue;
    }
    if (rule.severity !== undefined && severityOf(rule.severity, "warning") === null) add(pointerOf(["rules", name, "severity"]), `Severidad desconocida «${String(rule.severity)}»: usa error, warn, info, hint u off`);
    const thens = Array.isArray(rule.then) ? rule.then : [rule.then];
    thens.forEach((t, i) => {
      if (!FUNCTIONS[t.function]) add(pointerOf(["rules", name, "then", ...(Array.isArray(rule.then) ? [String(i)] : []), "function"]), `Función no admitida: «${t.function}». Specix tiene: ${Object.keys(FUNCTIONS).join(", ")}`, "guide/unknown-function");
    });
    for (const f of rule.formats ?? []) {
      if (!(FORMAT_NAMES as readonly string[]).includes(f)) add(pointerOf(["rules", name, "formats"]), `Formato desconocido «${f}»: usa ${FORMAT_NAMES.join(", ")}`);
    }
  }
  return out;
}

/**
 * Reads a guide and the guides it extends. Built-in guides are named
 * "specix:base"; others are paths relative to the guide that extends them.
 */
export function loadGuide(source: { name: string; text: string }, reader?: FileReader, seen: string[] = []): Guide {
  const problems: Guide["problems"] = [];
  let raw: unknown;
  try {
    raw = parse(source.text) ?? {};
  } catch {
    return { name: source.name, rules: [], problems: [{ guide: source.name, message: "La guía tiene errores de sintaxis" }] };
  }
  const parsed = guideSchema.safeParse(raw);
  if (!parsed.success) return { name: source.name, rules: [], problems: [{ guide: source.name, message: "La guía no tiene el formato esperado" }] };

  const rules = new Map<string, Rule>();
  const parents = parsed.data.extends === undefined ? [] : Array.isArray(parsed.data.extends) ? parsed.data.extends : [parsed.data.extends];
  for (const entry of parents) {
    const name = Array.isArray(entry) ? entry[0] : entry;
    // Spectral's own rulesets are not shipped; the built-in Specix base takes their place.
    const builtinName = name === "spectral:oas" || name === "spectral:asyncapi" ? "specix:base" : name;
    let parentSource: { name: string; text: string } | null = null;
    if (BUILTIN_GUIDES[builtinName]) parentSource = { name: builtinName, text: BUILTIN_GUIDES[builtinName] };
    else if (reader && !builtinName.includes(":")) {
      const path = resolve(dirname(source.name), builtinName);
      const text = reader.read(path);
      if (text !== null) parentSource = { name: path, text };
    }
    if (!parentSource) {
      problems.push({ guide: source.name, message: `No se encontró la guía «${name}» que extiende` });
      continue;
    }
    if (seen.includes(parentSource.name)) {
      problems.push({ guide: source.name, message: `Extensión circular: ${name}` });
      continue;
    }
    const parent = loadGuide(parentSource, reader, [...seen, source.name]);
    problems.push(...parent.problems);
    // "[name, off]" turns all its rules off unless re-enabled.
    const allOff = Array.isArray(entry) && entry[1] === "off";
    for (const rule of parent.rules) rules.set(rule.name, allOff ? { ...rule, severity: "off" } : rule);
  }

  for (const [name, def] of Object.entries(parsed.data.rules ?? {})) {
    if (typeof def !== "object") {
      const existing = rules.get(name);
      const severity = severityOf(def, existing?.severity ?? "warning");
      if (!existing) problems.push({ guide: source.name, message: `La regla «${name}» cambia la severidad de una regla que no existe` });
      else if (severity === null) problems.push({ guide: source.name, message: `Severidad desconocida en «${name}»` });
      else rules.set(name, { ...existing, severity });
      continue;
    }
    const severity = severityOf(def.severity, "warning");
    const thens = (Array.isArray(def.then) ? def.then : [def.then]).map((t) => ({ field: t.field ?? null, function: t.function, functionOptions: t.functionOptions ?? {} }));
    const unknown = thens.find((t) => !FUNCTIONS[t.function]);
    if (unknown) problems.push({ guide: source.name, message: `La regla «${name}» usa la función «${unknown.function}», que Specix no tiene; se omite` });
    if (severity === null) problems.push({ guide: source.name, message: `Severidad desconocida en «${name}»` });
    if (unknown || severity === null) continue;
    rules.set(name, {
      name,
      description: def.description ?? null,
      message: def.message ?? null,
      severity: def.recommended === false && def.severity === undefined ? "off" : severity,
      given: Array.isArray(def.given) ? def.given : [def.given],
      then: thens,
      formats: def.formats ?? null,
      origin: source.name,
    });
  }
  return { name: source.name, rules: [...rules.values()], problems };
}

export function builtinGuide(name = "specix:base"): Guide {
  return loadGuide({ name, text: BUILTIN_GUIDES[name] ?? "" });
}
