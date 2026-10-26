/** Outline of a document: operations, webhooks, channels and reusable components, with their line. */
import { isObject } from "./detect.js";
import { pointerOf, type LoadedDocument } from "./source.js";

export interface OutlineItem {
  kind: "operation" | "webhook" | "channel" | "component";
  /** Upper-case method for operations (GET, SEND…); null otherwise. */
  method: string | null;
  label: string;
  /** Where it belongs: a tag, "webhooks", "channels" or a components section. */
  group: string;
  pointer: string;
  line: number;
}

const MAX_OUTLINE = 1000;
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];

/** Operations, channels and components with their line, for the outline. */
export function outlineOf(doc: LoadedDocument): OutlineItem[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const items: OutlineItem[] = [];
  const push = (item: Omit<OutlineItem, "line">) => {
    if (items.length < MAX_OUTLINE) items.push({ ...item, line: doc.locate(item.pointer, "key").start.line });
  };

  for (const [section, kind] of [["paths", "operation"], ["webhooks", "webhook"]] as const) {
    const group = root[section];
    if (!isObject(group)) continue;
    for (const [path, item] of Object.entries(group)) {
      if (!isObject(item)) continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const tags = Array.isArray(op["tags"]) ? (op["tags"] as unknown[]) : [];
        push({
          kind,
          method: method.toUpperCase(),
          label: path,
          group: kind === "webhook" ? "webhooks" : typeof tags[0] === "string" ? tags[0] : "sin etiqueta",
          pointer: pointerOf([section, path, method]),
        });
      }
    }
  }

  if (typeof root["asyncapi"] === "string") {
    if (isObject(root["channels"])) {
      for (const [name, channel] of Object.entries(root["channels"])) {
        push({ kind: "channel", method: null, label: name, group: "channels", pointer: pointerOf(["channels", name]) });
        // AsyncAPI 2 keeps operations inside the channel.
        if (isObject(channel)) {
          for (const op of ["publish", "subscribe"]) {
            if (isObject(channel[op])) push({ kind: "operation", method: op.toUpperCase(), label: name, group: "operations", pointer: pointerOf(["channels", name, op]) });
          }
        }
      }
    }
    if (isObject(root["operations"])) {
      for (const [name, op] of Object.entries(root["operations"])) {
        const action = isObject(op) && typeof op["action"] === "string" ? op["action"].toUpperCase() : null;
        push({ kind: "operation", method: action, label: name, group: "operations", pointer: pointerOf(["operations", name]) });
      }
    }
  }

  const components: Array<[string[], unknown]> = isObject(root["components"]) ? Object.entries(root["components"]).map(([k, v]) => [["components", k], v]) : [];
  if (typeof root["swagger"] === "string") components.push([["definitions"], root["definitions"]]);
  for (const [prefix, group] of components) {
    if (!isObject(group)) continue;
    for (const name of Object.keys(group)) push({ kind: "component", method: null, label: name, group: prefix.at(-1)!, pointer: pointerOf([...prefix, name]) });
  }
  return items;
}
