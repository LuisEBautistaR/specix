/**
 * Documentation model of a definition: what a reader needs (operations by
 * tag, parameters, bodies, responses, schemas, AsyncAPI channels), already
 * resolved and flattened, with no layout. The desktop preview and the static
 * HTML export both render it.
 */
import { familyOf, isObject, type SpecFamily } from "../detect.js";
import { parsePointer } from "../source.js";
import { sampleJson, type SampleDirection } from "./example.js";

export interface DocSchema {
  /** Type label as written: "object", "string", "array<Pedido>", "string | null"… */
  type: string;
  /** Component name when the schema is a reference to one. */
  ref: string | null;
  description: string | null;
  /** Readable constraints: "1 a 50 elementos", "formato date-time", "por defecto 20"… */
  constraints: string[];
  enum: string[];
  properties: DocProperty[];
  items: DocSchema | null;
  /** oneOf / anyOf / allOf alternatives. */
  variants: { mode: "oneOf" | "anyOf" | "allOf"; options: DocSchema[] } | null;
}

export interface DocProperty {
  name: string;
  required: boolean;
  schema: DocSchema;
}

export interface DocParameter {
  name: string;
  in: string;
  required: boolean;
  deprecated: boolean;
  description: string | null;
  schema: DocSchema | null;
}

export interface DocContent {
  mediaType: string;
  schema: DocSchema | null;
  /** Example written in the document, as JSON or text. */
  example: string | null;
  /** Example built from the schema, for when the document has none. */
  sample: string | null;
}

export interface DocResponse {
  code: string;
  description: string;
  contents: DocContent[];
  headers: string[];
}

export interface DocOperation {
  /** Stable id for links: "post-pedidos". */
  anchor: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  operationId: string | null;
  deprecated: boolean;
  parameters: DocParameter[];
  requestBody: { required: boolean; description: string | null; contents: DocContent[] } | null;
  responses: DocResponse[];
  security: string[];
}

export interface DocGroup {
  name: string;
  description: string | null;
  operations: DocOperation[];
}

export interface DocChannel {
  anchor: string;
  name: string;
  address: string | null;
  description: string | null;
  operations: Array<{ name: string; action: string; summary: string | null }>;
  messages: Array<{ name: string; summary: string | null; payload: DocSchema | null; sample: string | null }>;
}

export interface DocModel {
  family: SpecFamily | null;
  title: string;
  version: string | null;
  description: string | null;
  servers: Array<{ url: string; description: string | null }>;
  groups: DocGroup[];
  webhooks: DocOperation[];
  channels: DocChannel[];
  schemas: Array<{ name: string; anchor: string; schema: DocSchema; sample: string | null }>;
  security: Array<{ name: string; type: string; description: string | null }>;
  operationCount: number;
}

type Json = Record<string, unknown>;
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 200;

export const anchorOf = (...parts: string[]) =>
  parts
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

function resolveLocal(root: Json, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const s of parsePointer(decodeURIComponent(ref.slice(1)))) node = isObject(node) || Array.isArray(node) ? (node as Json)[s] : undefined;
  return node;
}

const refName = (ref: string) => decodeURIComponent(ref.split("/").at(-1) ?? ref);

function constraintsOf(s: Json): string[] {
  const out: string[] = [];
  if (typeof s["format"] === "string") out.push(`formato ${s["format"]}`);
  const range = (min: unknown, max: unknown, unit: string) => {
    if (typeof min === "number" && typeof max === "number") out.push(`${min} a ${max}${unit}`);
    else if (typeof min === "number") out.push(`mínimo ${min}${unit}`);
    else if (typeof max === "number") out.push(`máximo ${max}${unit}`);
  };
  range(s["minimum"], s["maximum"], "");
  if (typeof s["exclusiveMinimum"] === "number") out.push(`mayor que ${s["exclusiveMinimum"]}`);
  if (typeof s["exclusiveMaximum"] === "number") out.push(`menor que ${s["exclusiveMaximum"]}`);
  range(s["minLength"], s["maxLength"], " caracteres");
  range(s["minItems"], s["maxItems"], " elementos");
  if (typeof s["pattern"] === "string") out.push(`patrón ${s["pattern"]}`);
  if (s["default"] !== undefined) out.push(`por defecto ${JSON.stringify(s["default"])}`);
  if (s["readOnly"] === true) out.push("solo lectura");
  if (s["writeOnly"] === true) out.push("solo escritura");
  if (s["nullable"] === true) out.push("admite null");
  if (s["deprecated"] === true) out.push("obsoleto");
  return out;
}

/** A schema as the docs show it; references to components stay as names below the top level. */
function schemaView(root: Json, raw: unknown, depth: number, seen: string[]): DocSchema {
  const empty: DocSchema = { type: "cualquiera", ref: null, description: null, constraints: [], enum: [], properties: [], items: null, variants: null };
  if (raw === true) return empty;
  if (!isObject(raw)) return empty;
  const ref = typeof raw["$ref"] === "string" ? raw["$ref"] : null;
  if (ref) {
    const name = refName(ref);
    const target = resolveLocal(root, ref);
    // Expand a component once at the top of a body or response; deeper it is a link.
    if (depth === 0 && isObject(target) && !seen.includes(ref)) return { ...schemaView(root, target, depth + 1, [...seen, ref]), ref: name };
    const description = str(raw["description"]) ?? (isObject(target) ? str(target["description"]) : null);
    return { ...empty, type: name, ref: name, description };
  }
  const view: DocSchema = { ...empty, description: str(raw["description"]), constraints: constraintsOf(raw) };
  if (Array.isArray(raw["enum"])) view.enum = (raw["enum"] as unknown[]).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  if ("const" in raw) view.enum = [typeof raw["const"] === "string" ? raw["const"] : JSON.stringify(raw["const"])];

  for (const mode of ["oneOf", "anyOf", "allOf"] as const) {
    const list = raw[mode];
    if (Array.isArray(list) && depth < MAX_DEPTH) {
      view.variants = { mode, options: list.map((s) => schemaView(root, s, depth + 1, seen)) };
      break;
    }
  }

  const types = Array.isArray(raw["type"]) ? (raw["type"] as unknown[]).map(String) : typeof raw["type"] === "string" ? [raw["type"]] : [];
  const isArray = types.includes("array") || raw["items"] !== undefined;
  const isObj = types.includes("object") || isObject(raw["properties"]);
  if (isArray && depth < MAX_DEPTH) {
    view.items = schemaView(root, raw["items"], depth + 1, seen);
    view.type = `array<${view.items.ref ?? view.items.type}>`;
    if (types.includes("null")) view.type += " | null";
  } else if (isObj) {
    view.type = types.length ? types.join(" | ") : "object";
    const required = new Set(Array.isArray(raw["required"]) ? (raw["required"] as unknown[]).map(String) : []);
    if (isObject(raw["properties"]) && depth < MAX_DEPTH) {
      view.properties = Object.entries(raw["properties"])
        .slice(0, MAX_PROPERTIES)
        .map(([name, sub]) => ({ name, required: required.has(name), schema: schemaView(root, sub, depth + 1, seen) }));
    }
  } else if (types.length) {
    view.type = types.join(" | ");
  } else if (view.variants) {
    view.type = view.variants.mode;
  }
  return view;
}

function contentsOf(root: Json, content: unknown, direction: SampleDirection): DocContent[] {
  if (!isObject(content)) return [];
  return Object.entries(content).map(([mediaType, media]) => {
    const m = isObject(media) ? media : {};
    let example: unknown = m["example"];
    if (example === undefined && isObject(m["examples"])) {
      const first = Object.values(m["examples"])[0];
      const resolved = isObject(first) && typeof first["$ref"] === "string" ? resolveLocal(root, first["$ref"]) : first;
      if (isObject(resolved)) example = resolved["value"];
    }
    return {
      mediaType,
      schema: m["schema"] === undefined ? null : schemaView(root, m["schema"], 0, []),
      example: example === undefined ? null : typeof example === "string" ? example : JSON.stringify(example, null, 2),
      sample: m["schema"] === undefined ? null : sampleJson(root, m["schema"], direction),
    };
  });
}

const deref = (root: Json, value: unknown): unknown => (isObject(value) && typeof value["$ref"] === "string" ? (resolveLocal(root, value["$ref"]) ?? value) : value);

function operationOf(root: Json, path: string, method: string, op: Json, inherited: unknown[], swagger: boolean): DocOperation {
  const params = [...inherited, ...(Array.isArray(op["parameters"]) ? (op["parameters"] as unknown[]) : [])].map((p) => deref(root, p)).filter(isObject);
  // An operation parameter replaces a path-level one with the same name and location.
  const unique = new Map<string, Json>();
  for (const p of params) unique.set(`${String(p["in"])}:${String(p["name"])}`, p);

  let requestBody: DocOperation["requestBody"] = null;
  const parameters: DocParameter[] = [];
  for (const p of unique.values()) {
    if (swagger && p["in"] === "body") {
      requestBody = { required: p["required"] === true, description: str(p["description"]), contents: [{ mediaType: "application/json", schema: schemaView(root, p["schema"], 0, []), example: null, sample: sampleJson(root, p["schema"], "request") }] };
      continue;
    }
    const schema = swagger ? schemaView(root, p, 1, []) : p["schema"] === undefined ? null : schemaView(root, p["schema"], 1, []);
    parameters.push({ name: String(p["name"] ?? ""), in: String(p["in"] ?? ""), required: p["required"] === true, deprecated: p["deprecated"] === true, description: str(p["description"]), schema });
  }
  const body = deref(root, op["requestBody"]);
  if (isObject(body)) requestBody = { required: body["required"] === true, description: str(body["description"]), contents: contentsOf(root, body["content"], "request") };

  const responses: DocResponse[] = [];
  if (isObject(op["responses"])) {
    for (const [code, raw] of Object.entries(op["responses"])) {
      const r = deref(root, raw);
      if (!isObject(r)) continue;
      const contents = swagger
        ? r["schema"] === undefined
          ? []
          : [{ mediaType: "application/json", schema: schemaView(root, r["schema"], 0, []), example: null, sample: sampleJson(root, r["schema"], "response") }]
        : contentsOf(root, r["content"], "response");
      responses.push({ code, description: str(r["description"]) ?? "", contents, headers: isObject(r["headers"]) ? Object.keys(r["headers"]) : [] });
    }
  }
  const security = Array.isArray(op["security"] ?? root["security"])
    ? ((op["security"] ?? root["security"]) as unknown[]).flatMap((s) => (isObject(s) ? Object.keys(s) : []))
    : [];
  return {
    anchor: anchorOf(method, path),
    method: method.toUpperCase(),
    path,
    summary: str(op["summary"]),
    description: str(op["description"]),
    operationId: str(op["operationId"]),
    deprecated: op["deprecated"] === true,
    parameters,
    requestBody,
    responses,
    security: [...new Set(security)],
  };
}

/** Builds the documentation model from a parsed (and, for multi-file definitions, bundled) document. */
export function docModel(value: unknown): DocModel {
  const root: Json = isObject(value) ? value : {};
  const { family } = familyOf(root);
  const info = isObject(root["info"]) ? root["info"] : {};
  const swagger = family === "swagger-2.0";
  const model: DocModel = {
    family,
    title: str(info["title"]) ?? "Sin título",
    version: str(info["version"]),
    description: str(info["description"]),
    servers: [],
    groups: [],
    webhooks: [],
    channels: [],
    schemas: [],
    security: [],
    operationCount: 0,
  };

  if (swagger) {
    const scheme = Array.isArray(root["schemes"]) && typeof root["schemes"][0] === "string" ? root["schemes"][0] : "https";
    if (typeof root["host"] === "string") model.servers.push({ url: `${scheme}://${root["host"]}${typeof root["basePath"] === "string" ? root["basePath"] : ""}`, description: null });
  } else if (Array.isArray(root["servers"])) {
    for (const s of root["servers"]) {
      if (!isObject(s)) continue;
      // AsyncAPI 3 keys servers by name; OpenAPI lists them.
      model.servers.push({ url: str(s["url"]) ?? `${str(s["protocol"]) ?? ""}://${str(s["host"]) ?? ""}`, description: str(s["description"]) });
    }
  } else if (isObject(root["servers"])) {
    for (const [name, s] of Object.entries(root["servers"])) {
      if (isObject(s)) model.servers.push({ url: str(s["url"]) ?? `${str(s["protocol"]) ?? ""}://${str(s["host"]) ?? name}`, description: str(s["description"]) });
    }
  }

  const tagInfo = new Map<string, string | null>();
  if (Array.isArray(root["tags"])) for (const t of root["tags"]) if (isObject(t) && typeof t["name"] === "string") tagInfo.set(t["name"], str(t["description"]));
  const groups = new Map<string, DocOperation[]>([...tagInfo.keys()].map((k) => [k, []]));

  const walkPaths = (section: unknown, into: (tag: string | null, op: DocOperation) => void) => {
    if (!isObject(section)) return;
    for (const [path, rawItem] of Object.entries(section)) {
      const item = deref(root, rawItem);
      if (!isObject(item)) continue;
      const inherited = Array.isArray(item["parameters"]) ? (item["parameters"] as unknown[]) : [];
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const tags = Array.isArray(op["tags"]) ? (op["tags"] as unknown[]).filter((t): t is string => typeof t === "string") : [];
        into(tags[0] ?? null, operationOf(root, path, method, op, inherited, swagger));
      }
    }
  };
  walkPaths(root["paths"], (tag, op) => {
    const name = tag ?? "Sin etiqueta";
    groups.set(name, [...(groups.get(name) ?? []), op]);
    model.operationCount++;
  });
  walkPaths(root["webhooks"], (_tag, op) => {
    model.webhooks.push({ ...op, anchor: anchorOf("webhook", op.method, op.path) });
    model.operationCount++;
  });
  model.groups = [...groups.entries()].filter(([, ops]) => ops.length > 0).map(([name, operations]) => ({ name, description: tagInfo.get(name) ?? null, operations }));

  if (family === "asyncapi-2" || family === "asyncapi-3") {
    const messageOf = (name: string, raw: unknown) => {
      const m = deref(root, raw);
      return { name: isObject(m) ? (str(m["name"]) ?? str(m["title"]) ?? name) : name, summary: isObject(m) ? str(m["summary"]) : null, payload: isObject(m) && m["payload"] !== undefined ? schemaView(root, m["payload"], 0, []) : null, sample: isObject(m) && m["payload"] !== undefined ? sampleJson(root, m["payload"]) : null };
    };
    const channels = isObject(root["channels"]) ? root["channels"] : {};
    for (const [name, raw] of Object.entries(channels)) {
      const ch = deref(root, raw);
      if (!isObject(ch)) continue;
      const channel: DocChannel = { anchor: anchorOf("canal", name), name, address: str(ch["address"]) ?? (family === "asyncapi-2" ? name : null), description: str(ch["description"]), operations: [], messages: [] };
      if (isObject(ch["messages"])) for (const [mName, m] of Object.entries(ch["messages"])) channel.messages.push(messageOf(mName, m));
      // AsyncAPI 2: operations live in the channel.
      for (const action of ["publish", "subscribe"]) {
        const op = ch[action];
        if (!isObject(op)) continue;
        channel.operations.push({ name: str(op["operationId"]) ?? action, action: action === "publish" ? "receive" : "send", summary: str(op["summary"]) });
        if (op["message"] !== undefined) channel.messages.push(messageOf(action, op["message"]));
        model.operationCount++;
      }
      model.channels.push(channel);
    }
    if (isObject(root["operations"])) {
      for (const [name, raw] of Object.entries(root["operations"])) {
        if (!isObject(raw)) continue;
        const target = isObject(raw["channel"]) && typeof raw["channel"]["$ref"] === "string" ? refName(raw["channel"]["$ref"]) : null;
        const channel = model.channels.find((c) => c.name === target);
        const entry = { name, action: str(raw["action"]) ?? "", summary: str(raw["summary"]) ?? str(raw["title"]) };
        if (channel) channel.operations.push(entry);
        model.operationCount++;
      }
    }
  }

  const schemas = swagger ? root["definitions"] : isObject(root["components"]) ? root["components"]["schemas"] : undefined;
  if (isObject(schemas)) {
    for (const [name, s] of Object.entries(schemas)) model.schemas.push({ name, anchor: anchorOf("esquema", name), schema: schemaView(root, s, 1, []), sample: sampleJson(root, s) });
  }
  const schemes = swagger ? root["securityDefinitions"] : isObject(root["components"]) ? root["components"]["securitySchemes"] : undefined;
  if (isObject(schemes)) {
    for (const [name, raw] of Object.entries(schemes)) {
      const s = deref(root, raw);
      if (!isObject(s)) continue;
      const kind = [str(s["type"]), str(s["scheme"]), str(s["in"]) ? `en ${String(s["in"])}` : null].filter(Boolean).join(" · ");
      model.security.push({ name, type: kind, description: str(s["description"]) });
    }
  }
  return model;
}
