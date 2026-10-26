/**
 * Rule functions. The names and options follow the ones style guides in the
 * Spectral format use, so existing guides keep working; the code is Specix's.
 * Each function gets the value found by "given" (and "field") and returns the
 * problems it sees, or nothing.
 */
import { Ajv } from "ajv";
import { isObject } from "../detect.js";

export interface FunctionContext {
  /** The whole document, for functions that look beyond the target. */
  document: unknown;
  /** JSON Pointer of the target value. */
  pointer: string;
}

export interface FunctionResult {
  /** Overrides the rule's message (still passed through its placeholders). */
  message?: string;
  /** Extra path segments below the target, to point at the exact spot. */
  path?: string[];
}

export type RuleFunction = (value: unknown, options: Record<string, unknown>, ctx: FunctionContext) => FunctionResult[];

const fail = (message?: string, path?: string[]): FunctionResult[] => [{ ...(message ? { message } : {}), ...(path ? { path } : {}) }];

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

const CASES: Record<string, RegExp> = {
  flat: /^[a-z][a-z{__DIGITS__}]*$/,
  camel: /^[a-z][a-z{__DIGITS__}]*(?:[A-Z{__DIGITS__}](?:[a-z{__DIGITS__}]+|$))*$/,
  pascal: /^[A-Z][a-z{__DIGITS__}]*(?:[A-Z{__DIGITS__}](?:[a-z{__DIGITS__}]+|$))*$/,
  kebab: /^[a-z][a-z{__DIGITS__}]*(?:-[a-z{__DIGITS__}]+)*$/,
  cobol: /^[A-Z][A-Z{__DIGITS__}]*(?:-[A-Z{__DIGITS__}]+)*$/,
  snake: /^[a-z][a-z{__DIGITS__}]*(?:_[a-z{__DIGITS__}]+)*$/,
  macro: /^[A-Z][A-Z{__DIGITS__}]*(?:_[A-Z{__DIGITS__}]+)*$/,
};

const CASE_NAMES: Record<string, string> = { flat: "flat", camel: "camelCase", pascal: "PascalCase", kebab: "kebab-case", cobol: "COBOL-CASE", snake: "snake_case", macro: "MACRO_CASE" };

function casingRegex(type: string, disallowDigits: boolean, separator: { char?: unknown; allowLeading?: unknown } | null): RegExp | null {
  const base = CASES[type];
  if (!base) return null;
  const digits = disallowDigits ? "" : "0-9";
  const word = base.source.replace(/\{__DIGITS__\}/g, digits);
  if (!separator || typeof separator.char !== "string" || separator.char.length !== 1) return new RegExp(word);
  // Words of the case joined by a separator, e.g. camelCase segments split by "/".
  const inner = word.slice(1, -1);
  const sep = separator.char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${separator.allowLeading === true ? `${sep}?` : ""}${inner}(?:${sep}${inner})*$`);
}

const ajv = new Ajv({ strict: false, allErrors: false, logger: false });

export const FUNCTIONS: Record<string, RuleFunction> = {
  truthy: (v) => (isEmpty(v) ? fail() : []),
  falsy: (v) => (isEmpty(v) ? [] : fail()),
  defined: (v) => (v === undefined ? fail() : []),
  undefined: (v) => (v === undefined ? [] : fail()),

  pattern(v, o) {
    if (typeof v !== "string") return [];
    const out: FunctionResult[] = [];
    const test = (pattern: unknown) => {
      if (typeof pattern !== "string") return null;
      const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
      try {
        return m ? new RegExp(m[1]!, m[2]) : new RegExp(pattern);
      } catch {
        return null;
      }
    };
    const match = test(o["match"]);
    const notMatch = test(o["notMatch"]);
    if (match && !match.test(v)) out.push({ message: `«${v}» no cumple el patrón ${String(o["match"])}` });
    if (notMatch && notMatch.test(v)) out.push({ message: `«${v}» no debe cumplir el patrón ${String(o["notMatch"])}` });
    return out;
  },

  casing(v, o) {
    if (typeof v !== "string" || v === "") return [];
    const type = String(o["type"] ?? "");
    const regex = casingRegex(type, o["disallowDigits"] === true, isObject(o["separator"]) ? o["separator"] : null);
    if (!regex) return fail(`Tipo de mayúsculas desconocido: ${type}`);
    return regex.test(v) ? [] : fail(`«${v}» debe ir en ${CASE_NAMES[type] ?? type}`);
  },

  enumeration(v, o) {
    const values = Array.isArray(o["values"]) ? (o["values"] as unknown[]) : [];
    if (v === undefined || values.includes(v)) return [];
    return fail(`«${String(v)}» no es uno de: ${values.map(String).join(", ")}`);
  },

  length(v, o) {
    const size = typeof v === "string" || Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : typeof v === "number" ? v : null;
    if (size === null) return [];
    if (typeof o["min"] === "number" && size < o["min"]) return fail(`Mide ${size}; el mínimo es ${o["min"]}`);
    if (typeof o["max"] === "number" && size > o["max"]) return fail(`Mide ${size}; el máximo es ${o["max"]}`);
    return [];
  },

  alphabetical(v, o) {
    const keyedBy = typeof o["keyedBy"] === "string" ? o["keyedBy"] : null;
    const items = Array.isArray(v) ? v.map((x) => (keyedBy && isObject(x) ? x[keyedBy] : x)) : isObject(v) ? Object.keys(v) : null;
    if (!items) return [];
    for (let i = 1; i < items.length; i++) {
      if (String(items[i - 1]).localeCompare(String(items[i])) > 0) return fail(`«${String(items[i])}» debería ir antes que «${String(items[i - 1])}»`, Array.isArray(v) ? [String(i)] : []);
    }
    return [];
  },

  xor(v, o) {
    if (!isObject(v)) return [];
    const props = Array.isArray(o["properties"]) ? (o["properties"] as unknown[]).map(String) : [];
    const present = props.filter((p) => v[p] !== undefined);
    return present.length === 1 ? [] : fail(`Debe tener exactamente una de: ${props.join(", ")}`);
  },

  schema(v, o) {
    if (v === undefined || !isObject(o["schema"])) return [];
    let validate;
    try {
      validate = ajv.compile(o["schema"]);
    } catch {
      return fail("El esquema de la regla no es válido");
    }
    if (validate(v)) return [];
    return (validate.errors ?? []).slice(0, 5).map((e) => ({ message: `${e.instancePath || "valor"} ${e.message ?? "no cumple el esquema"}`, path: e.instancePath.split("/").slice(1) }));
  },

  /** Specix: a reusable component that nothing references. Target: a components group (e.g. $.components.schemas). */
  unusedComponent(v, _o, ctx) {
    if (!isObject(v)) return [];
    const text = JSON.stringify(ctx.document);
    return Object.keys(v)
      .filter((name) => {
        const ref = `#${ctx.pointer}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        return !text.includes(`"${ref}"`) && !text.includes(`"${encodeURI(ref)}"`);
      })
      .map((name) => ({ message: `«${name}» no se usa en ninguna parte del documento`, path: [name] }));
  },

  /** Specix: an operation's responses must include a success (2xx or 3xx). Target: a responses object. */
  successResponse(v) {
    if (!isObject(v)) return [];
    return Object.keys(v).some((code) => /^[23]/.test(code) || /^[23]XX$/i.test(code)) ? [] : fail("No hay ninguna respuesta de éxito (2xx o 3xx)");
  },
};
