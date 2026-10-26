/**
 * Sample values built from a schema, for reading a contract: what a body or a
 * response looks like with data in it. Values written in the document win
 * (example, examples, default, const, enum); the rest come from the type and
 * format. Cycles and deep nesting stop early instead of growing forever.
 */
import { isObject } from "../detect.js";
import { parsePointer } from "../source.js";

type Json = Record<string, unknown>;

/** "request" leaves out readOnly properties; "response" leaves out writeOnly ones. */
export type SampleDirection = "request" | "response";

const MAX_DEPTH = 8;
const MAX_PROPERTIES = 60;
const OMIT = Symbol("omit");

const STRING_FORMATS: Record<string, string> = {
  "date-time": "2026-03-14T10:30:00Z",
  date: "2026-03-14",
  time: "10:30:00",
  duration: "P3D",
  email: "ana.lopez@ejemplo.com",
  "idn-email": "ana.lopez@ejemplo.com",
  hostname: "api.ejemplo.com",
  "idn-hostname": "api.ejemplo.com",
  ipv4: "192.0.2.10",
  ipv6: "2001:db8::10",
  uri: "https://ejemplo.com/recurso",
  "uri-reference": "/recurso/1",
  iri: "https://ejemplo.com/recurso",
  url: "https://ejemplo.com/recurso",
  uuid: "0b6f2c1e-8a4d-4c3b-9e2f-5d7a1b3c4e6f",
  byte: "U3BlY2l4",
  binary: "<archivo>",
  password: "********",
  regex: "^[a-z]+$",
  "json-pointer": "/a/b",
};

function resolveLocal(root: Json, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const s of parsePointer(decodeURIComponent(ref.slice(1)))) node = isObject(node) || Array.isArray(node) ? (node as Json)[s] : undefined;
  return node;
}

/** A plausible string for a property, from its format first and then its name. */
function stringFor(s: Json, name: string | null): string {
  const format = typeof s["format"] === "string" ? s["format"] : null;
  if (format && STRING_FORMATS[format]) return STRING_FORMATS[format];
  const n = (name ?? "").toLowerCase();
  let value = "texto";
  if (/id$|sku|codigo|^code$/.test(n)) value = n.includes("sku") ? "SKU-1001" : "a1b2c3";
  else if (/correo|email|mail/.test(n)) value = "ana.lopez@ejemplo.com";
  else if (/nombre|name|titulo|title/.test(n)) value = n.includes("title") || n.includes("titulo") ? "Título" : "Ana López";
  else if (/url|enlace|link|web/.test(n)) value = "https://ejemplo.com";
  else if (/telefono|phone/.test(n)) value = "+52 55 1234 5678";
  else if (/fecha|date/.test(n)) value = "2026-03-14";
  else if (/moneda|currency/.test(n)) value = "MXN";
  else if (/descripcion|description|nota|comentario|mensaje|message/.test(n)) value = "Texto de ejemplo";
  else if (/estado|status/.test(n)) value = "activo";
  const min = typeof s["minLength"] === "number" ? s["minLength"] : 0;
  const max = typeof s["maxLength"] === "number" ? s["maxLength"] : Infinity;
  while (value.length < min) value += "x";
  return value.length > max ? value.slice(0, Math.max(max, 0)) : value;
}

function numberFor(s: Json, integer: boolean): number {
  const min = typeof s["minimum"] === "number" ? s["minimum"] : typeof s["exclusiveMinimum"] === "number" ? s["exclusiveMinimum"] + (integer ? 1 : 0.5) : null;
  const max = typeof s["maximum"] === "number" ? s["maximum"] : typeof s["exclusiveMaximum"] === "number" ? s["exclusiveMaximum"] - (integer ? 1 : 0.5) : null;
  let value = min ?? (max !== null ? Math.min(max, integer ? 1 : 1.5) : integer ? 1 : 10.5);
  if (typeof s["multipleOf"] === "number" && s["multipleOf"] > 0) value = Math.ceil(value / s["multipleOf"]) * s["multipleOf"];
  return integer ? Math.round(value) : value;
}

function sample(root: Json, raw: unknown, direction: SampleDirection, depth: number, seen: string[], name: string | null): unknown {
  if (raw === true || raw === undefined) return {};
  if (!isObject(raw) || depth > MAX_DEPTH) return OMIT;
  if (typeof raw["$ref"] === "string") {
    const ref = raw["$ref"];
    if (seen.includes(ref)) return OMIT;
    const target = resolveLocal(root, ref);
    return target === undefined ? OMIT : sample(root, target, direction, depth + 1, [...seen, ref], name);
  }
  if (raw["example"] !== undefined) return raw["example"];
  if (Array.isArray(raw["examples"]) && raw["examples"].length > 0) return raw["examples"][0];
  if (raw["const"] !== undefined) return raw["const"];
  if (raw["default"] !== undefined) return raw["default"];
  if (Array.isArray(raw["enum"]) && raw["enum"].length > 0) return raw["enum"][0];

  if (Array.isArray(raw["allOf"])) {
    const parts = raw["allOf"].map((p) => sample(root, p, direction, depth + 1, seen, name)).filter((p) => p !== OMIT);
    const own = isObject(raw["properties"]) ? sample(root, { ...raw, allOf: undefined }, direction, depth, seen, name) : OMIT;
    if (own !== OMIT) parts.push(own);
    if (parts.every((p) => isObject(p))) return Object.assign({}, ...parts);
    return parts[0] ?? OMIT;
  }
  for (const mode of ["oneOf", "anyOf"]) {
    const list = raw[mode];
    if (Array.isArray(list) && list.length > 0) {
      // Prefer an alternative that is not just null.
      const pick = list.find((o) => !(isObject(o) && o["type"] === "null")) ?? list[0];
      return sample(root, pick, direction, depth + 1, seen, name);
    }
  }

  const types = Array.isArray(raw["type"]) ? raw["type"].map(String) : typeof raw["type"] === "string" ? [raw["type"]] : [];
  const type = types.find((t) => t !== "null") ?? (isObject(raw["properties"]) || isObject(raw["additionalProperties"]) ? "object" : raw["items"] !== undefined ? "array" : types[0]);
  switch (type) {
    case "object": {
      const out: Json = {};
      if (isObject(raw["properties"])) {
        for (const [prop, sub] of Object.entries(raw["properties"]).slice(0, MAX_PROPERTIES)) {
          const s = isObject(sub) && typeof sub["$ref"] === "string" ? resolveLocal(root, sub["$ref"]) : sub;
          if (isObject(s) && ((direction === "request" && s["readOnly"] === true) || (direction === "response" && s["writeOnly"] === true))) continue;
          const value = sample(root, sub, direction, depth + 1, seen, prop);
          if (value !== OMIT) out[prop] = value;
        }
      }
      if (isObject(raw["additionalProperties"]) && Object.keys(out).length === 0) {
        const value = sample(root, raw["additionalProperties"], direction, depth + 1, seen, null);
        if (value !== OMIT) out["clave"] = value;
      }
      return out;
    }
    case "array": {
      const item = sample(root, raw["items"], direction, depth + 1, seen, name);
      return item === OMIT ? [] : [item];
    }
    case "string":
      return stringFor(raw, name);
    case "integer":
      return numberFor(raw, true);
    case "number":
      return numberFor(raw, false);
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return isObject(raw["properties"]) ? sample(root, { ...raw, type: "object" }, direction, depth, seen, name) : OMIT;
  }
}

/** A sample value for a schema of the document, or undefined when nothing sensible can be built. */
export function sampleOf(root: unknown, schema: unknown, direction: SampleDirection = "response"): unknown {
  const value = sample(isObject(root) ? root : {}, schema, direction, 0, [], null);
  return value === OMIT ? undefined : value;
}

/** The same sample, as indented JSON. */
export function sampleJson(root: unknown, schema: unknown, direction: SampleDirection = "response"): string | null {
  const value = sampleOf(root, schema, direction);
  return value === undefined ? null : JSON.stringify(value, null, 2);
}
