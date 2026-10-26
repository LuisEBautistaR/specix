/** Runs a style guide over a parsed document and turns rule failures into diagnostics. */
import { JSONPath } from "jsonpath-plus";
import type { SpecFamily } from "../detect.js";
import { parsePointer, pointerOf, type Diagnostic, type LoadedDocument } from "../source.js";
import { FUNCTIONS } from "./functions.js";
import { formatsOf, type Guide, type Rule } from "./guide.js";

/** Never more results per rule: a broken pattern over a big document should not flood the panel. */
const MAX_PER_RULE = 200;

interface Match {
  pointer: string;
  value: unknown;
  /** Key of the matched value in its parent, for "@key" fields. */
  key: string | null;
}

function query(path: string, json: unknown): Match[] {
  try {
    const results = JSONPath({ path, json: json as object, resultType: "all", eval: "safe", wrap: true }) as Array<{ pointer: string; value: unknown; parentProperty: string | number | null }>;
    return results.map((r) => ({ pointer: r.pointer, value: r.value, key: r.parentProperty === null || r.parentProperty === undefined ? null : String(r.parentProperty) }));
  } catch {
    return [];
  }
}

function valueAt(root: unknown, pointer: string): unknown {
  let node = root;
  for (const s of parsePointer(pointer)) node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[s] : undefined;
  return node;
}

const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)?.slice(0, 80) ?? "");

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(value|property|path|error|description)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

export interface GuideRun {
  diagnostics: Diagnostic[];
  /** Rules that applied to this document (format and severity). */
  rulesRun: number;
}

export function applies(rule: Rule, family: SpecFamily | null): boolean {
  if (rule.severity === "off") return false;
  if (!rule.formats) return true;
  const formats = formatsOf(family);
  return rule.formats.some((f) => formats.includes(f));
}

export function runGuide(guide: Guide, doc: LoadedDocument, family: SpecFamily | null): GuideRun {
  const root = doc.value;
  const diagnostics: Diagnostic[] = [];
  let rulesRun = 0;
  for (const rule of guide.rules) {
    if (!applies(rule, family) || rule.severity === "off") continue;
    rulesRun++;
    let count = 0;
    for (const given of rule.given) {
      for (const match of query(given, root)) {
        for (const then of rule.then) {
          const fn = FUNCTIONS[then.function];
          if (!fn) continue;
          // What the function looks at: the match itself, its key, a field of it, or a sub-query.
          let targets: Match[];
          if (then.field === null) targets = [match];
          else if (then.field === "@key") {
            // Every key of the matched object, as Spectral does.
            const obj = match.value;
            targets = obj !== null && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).map((k) => ({ pointer: match.pointer + pointerOf([k]), value: k, key: k })) : [];
          }
          else if (then.field.startsWith("$")) targets = query(then.field, match.value).map((m) => ({ ...m, pointer: match.pointer + m.pointer }));
          else {
            const pointer = match.pointer + pointerOf(then.field.split("."));
            targets = [{ pointer, value: valueAt(root, pointer), key: then.field.split(".").at(-1)! }];
          }
          for (const target of targets) {
            for (const result of fn(target.value, then.functionOptions, { document: root, pointer: target.pointer })) {
              if (count++ >= MAX_PER_RULE) break;
              const pointer = result.path?.length ? target.pointer + pointerOf(result.path) : target.pointer;
              const property = result.path?.at(-1) ?? target.key ?? parsePointer(target.pointer).at(-1) ?? "";
              const vars = { value: show(target.value), property, path: pointer, error: result.message ?? "", description: rule.description ?? "" };
              const message = rule.message ? interpolate(rule.message, vars) : (result.message ?? rule.description ?? `No cumple la regla ${rule.name}`);
              diagnostics.push({ severity: rule.severity, code: `guia/${rule.name}`, message, source: "guía", pointer, range: doc.locate(pointer, "key") });
            }
          }
        }
      }
    }
  }
  return { diagnostics, rulesRun };
}
