/**
 * Walks an official JSON Schema along a document path to answer "which keys
 * can go here?" and "which values are allowed here?" for completion and hover.
 * It follows $ref (local, and absolute ids embedded in the AsyncAPI bundles),
 * allOf/anyOf/oneOf, if/then/else, properties, patternProperties,
 * additionalProperties and items. The answer is a union over alternatives.
 */
type Schema = Record<string, unknown>;

interface Located {
  node: Schema;
  /** The schema resource that local "#/…" references in node resolve against. */
  resource: Schema;
}

export interface KeyInfo {
  name: string;
  /** Short type label, e.g. "texto", "objeto", "lista". */
  type: string | null;
  description: string | null;
  required: boolean;
}

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

const TYPE_LABELS: Record<string, string> = {
  string: "texto",
  number: "número",
  integer: "entero",
  boolean: "booleano",
  object: "objeto",
  array: "lista",
  null: "nulo",
};

export class SchemaNavigator {
  readonly #root: Schema;
  readonly #byId = new Map<string, Schema>();

  constructor(root: object) {
    this.#root = root as Schema;
    const index = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(index);
      if (!isSchema(node)) return;
      const id = node["$id"] ?? node["id"];
      if (typeof id === "string" && /^[a-z]+:/i.test(id)) this.#byId.set(id.split("#")[0]!, node);
      for (const value of Object.values(node)) index(value);
    };
    index(root);
  }

  #pointer(resource: Schema, pointer: string): Schema | null {
    let node: unknown = resource;
    for (const raw of pointer.split("/").slice(1)) {
      const segment = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (!isSchema(node) && !Array.isArray(node)) return null;
      node = (node as Record<string, unknown>)[segment];
    }
    return isSchema(node) ? node : null;
  }

  #resolve(ref: string, from: Located): Located | null {
    const [base, fragment = ""] = ref.split("#");
    let resource = from.resource;
    if (base) {
      const found = this.#byId.get(base) ?? this.#byId.get(base.replace(/\.json$/, ""));
      if (!found) return null;
      resource = found;
    }
    // Plain-name anchors ("#meta") are not followed: callers pass schemas with them already inlined.
    const node = fragment ? (fragment.startsWith("/") ? this.#pointer(resource, fragment) : null) : resource;
    return node ? { node, resource: base ? resource : from.resource } : null;
  }

  /** Concrete schema objects behind a node: references and combinators flattened. */
  #expand(start: Located[]): Located[] {
    const out: Located[] = [];
    const seen = new Set<Schema>();
    const queue = [...start];
    while (queue.length && out.length < 200) {
      const item = queue.shift()!;
      if (seen.has(item.node)) continue;
      seen.add(item.node);
      const node = item.node;
      // A node with its own $id starts a new resource for its local references.
      const resource = typeof node["$id"] === "string" && node !== item.resource ? node : item.resource;
      const here = { node, resource };
      out.push(here);
      for (const key of ["$ref", "$dynamicRef"]) {
        const ref = node[key];
        if (typeof ref === "string") {
          const target = this.#resolve(ref, here);
          if (target) queue.push(target);
        }
      }
      for (const key of ["allOf", "anyOf", "oneOf"]) {
        const list = node[key];
        if (Array.isArray(list)) for (const sub of list) if (isSchema(sub)) queue.push({ node: sub, resource });
      }
      for (const key of ["then", "else"]) if (isSchema(node[key])) queue.push({ node: node[key] as Schema, resource });
    }
    return out;
  }

  #step(nodes: Located[], segment: string): Located[] {
    const next: Located[] = [];
    for (const { node, resource } of nodes) {
      const props = node["properties"];
      if (isSchema(props) && isSchema(props[segment])) {
        next.push({ node: props[segment] as Schema, resource });
        continue;
      }
      let matched = false;
      const patterns = node["patternProperties"];
      if (isSchema(patterns)) {
        for (const [pattern, sub] of Object.entries(patterns)) {
          try {
            if (isSchema(sub) && new RegExp(pattern, "u").test(segment)) {
              next.push({ node: sub, resource });
              matched = true;
            }
          } catch {
            // A pattern JavaScript cannot compile simply does not match.
          }
        }
      }
      if (!matched && isSchema(node["additionalProperties"])) next.push({ node: node["additionalProperties"] as Schema, resource });
      if (/^\d+$/.test(segment)) {
        const items = node["items"];
        if (isSchema(items)) next.push({ node: items, resource });
        else if (Array.isArray(items) && isSchema(items[Number(segment)])) next.push({ node: items[Number(segment)] as Schema, resource });
      }
    }
    return this.#expand(next);
  }

  /** Schema nodes that apply at a document path (segments as in a JSON Pointer, list indexes as numbers). */
  at(segments: readonly string[]): Located[] {
    let nodes = this.#expand([{ node: this.#root, resource: this.#root }]);
    for (const segment of segments) {
      nodes = this.#step(nodes, segment);
      if (nodes.length === 0) break;
    }
    return nodes;
  }

  /** Keys the schema names for the object at a path, in schema order. */
  keys(segments: readonly string[]): KeyInfo[] {
    const found = new Map<string, KeyInfo>();
    for (const { node, resource } of this.at(segments)) {
      const required = new Set(Array.isArray(node["required"]) ? (node["required"] as unknown[]).map(String) : []);
      const props = node["properties"];
      if (!isSchema(props)) continue;
      for (const [name, sub] of Object.entries(props)) {
        const info = this.describe([{ node: isSchema(sub) ? sub : {}, resource }]);
        const prev = found.get(name);
        found.set(name, {
          name,
          type: prev?.type ?? info.type,
          description: prev?.description ?? info.description,
          required: (prev?.required ?? false) || required.has(name),
        });
      }
    }
    return [...found.values()];
  }

  /** Values a schema allows at a path (enum and const), plus true/false for booleans. */
  values(segments: readonly string[]): string[] {
    const values = new Set<string>();
    for (const { node } of this.at(segments)) {
      if (Array.isArray(node["enum"])) for (const v of node["enum"] as unknown[]) if (v !== null && typeof v !== "object") values.add(String(v));
      if ("const" in node && node["const"] !== null && typeof node["const"] !== "object") values.add(String(node["const"]));
      if (node["type"] === "boolean") ["true", "false"].forEach((v) => values.add(v));
    }
    return [...values];
  }

  /** Type label and description of the first node that has them. */
  describe(located: Located[]): { type: string | null; description: string | null } {
    let type: string | null = null;
    let description: string | null = null;
    for (const { node } of this.#expand(located)) {
      if (type === null && node["type"] !== undefined) {
        const types = Array.isArray(node["type"]) ? (node["type"] as string[]) : [String(node["type"])];
        type = types.map((t) => TYPE_LABELS[t] ?? t).join(" o ");
      }
      if (description === null && typeof node["description"] === "string") description = node["description"];
      if (type !== null && description !== null) break;
    }
    return { type, description };
  }
}
