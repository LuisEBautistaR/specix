/**
 * Language service for the editor: completion, hover, go to definition,
 * breadcrumb and outline. Completion works on text that may not parse yet
 * (the user is typing), so the cursor's place in a YAML document is worked out
 * from indentation; the rest uses the parsed document when there is one.
 */
import { familyOf, isObject, type SpecFamily } from "./detect.js";
import { SchemaNavigator } from "./schema-nav.js";
import { loadDocument, parsePointer, pointerOf, type LoadedDocument, type Position, type Range } from "./source.js";
import { schemaDocumentFor } from "./validate.js";
import { KEY_DOCS } from "./vocabulary.js";

export interface CompletionItem {
  label: string;
  /** Text that replaces the range from…to. */
  insert: string;
  kind: "property" | "value" | "reference";
  /** Short note shown next to the label, e.g. "objeto · obligatoria". */
  detail: string | null;
  /** Longer Spanish explanation, when Specix has one. */
  info: string | null;
}

export interface CompletionResult {
  from: Position;
  to: Position;
  items: CompletionItem[];
}

export interface HoverResult {
  range: Range;
  title: string;
  text: string | null;
  type: string | null;
}



// The same document is asked for completion, hover and breadcrumb in quick succession.
let cached: { source: string; doc: LoadedDocument } | null = null;
function load(source: string): LoadedDocument {
  if (cached?.source !== source) cached = { source, doc: loadDocument(source) };
  return cached.doc;
}

/** Family and version from the text itself, so it works while the document does not parse. */
export function familyFromText(source: string): { family: SpecFamily; specVersion: string } | null {
  const m = /^\s*["']?(openapi|swagger|asyncapi)["']?\s*:\s*["']?([0-9][\w.-]*)/m.exec(source);
  if (!m) return null;
  const { family, specVersion } = familyOf({ [m[1]!]: m[2]! });
  return family && specVersion ? { family, specVersion } : null;
}

const navigators = new Map<string, SchemaNavigator>();
function navigatorFor(source: string): SchemaNavigator | null {
  const spec = familyFromText(source);
  if (!spec) return null;
  const key = `${spec.family}@${spec.specVersion}`;
  let nav = navigators.get(key);
  if (!nav) {
    nav = new SchemaNavigator(schemaDocumentFor(spec.family, spec.specVersion));
    navigators.set(key, nav);
  }
  return nav;
}

const indentOf = (line: string) => /^ */.exec(line)![0].length;
const isBlank = (line: string) => /^\s*(#.*)?$/.test(line);
const KEY_LINE = /^\s*(?:-\s+)?(?:'([^']*)'|"([^"]*)"|([^\s'"#:][^#:]*?))\s*:(?:\s|$)/;
const keyOfLine = (line: string): string | null => {
  const m = KEY_LINE.exec(line);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};

/**
 * Path of the object that holds a key typed at `indent` on line `lineIndex`
 * (0-based), read from the indentation of the lines above. List items become
 * index "0": the schema treats every item alike.
 */
export function yamlPathAt(lines: readonly string[], lineIndex: number, indent: number, inItem = false): string[] {
  const segments: string[] = inItem ? ["0"] : [];
  let target = indent;
  let inSequence = inItem;
  for (let j = lineIndex - 1; j >= 0 && target > 0; j--) {
    const line = lines[j]!;
    if (isBlank(line)) continue;
    const lead = indentOf(line);
    const dash = /^(\s*)-\s+/.exec(line);
    if (dash) {
      // Another item of the same list: not an ancestor.
      if (inSequence && lead === target) continue;
      if (dash[0].length <= target && lead < target) {
        segments.unshift("0");
        target = lead;
        inSequence = true;
        continue;
      }
    }
    if (lead < target || (inSequence && lead <= target)) {
      const key = keyOfLine(line);
      if (key !== null && !dash) {
        segments.unshift(key);
        target = lead;
        inSequence = false;
      }
    }
  }
  return segments;
}

/** Keys already written in the same block as the line being typed. */
function siblingKeys(lines: readonly string[], lineIndex: number, indent: number): Set<string> {
  const keys = new Set<string>();
  const scan = (from: number, step: 1 | -1) => {
    for (let j = from; j >= 0 && j < lines.length; j += step) {
      const line = lines[j]!;
      if (isBlank(line)) continue;
      const lead = indentOf(line);
      const dash = /^(\s*)-\s+/.exec(line);
      const contentIndent = dash ? dash[0].length : lead;
      if (contentIndent < indent || (dash && contentIndent === indent && step === 1)) break;
      if (contentIndent === indent) {
        const key = keyOfLine(line);
        if (key !== null) keys.add(key);
        if (dash) break;
      }
    }
  };
  scan(lineIndex - 1, -1);
  scan(lineIndex + 1, 1);
  return keys;
}

/** Every local target a $ref can point at: reusable components, definitions and channels. */
function referenceTargets(source: string, lineIndex: number): string[] {
  // While the user types, the current line often breaks the document (an open quote):
  // read it without that line, and failing that use the last version that parsed.
  let value = load(source).value;
  if (value === undefined) {
    const lines = source.split("\n");
    lines[lineIndex] = "";
    value = loadDocument(lines.join("\n")).value;
  }
  if (value !== undefined) lastGood = { value };
  else value = lastGood?.value;
  if (!isObject(value)) return [];
  const targets: string[] = [];
  const add = (prefix: string[], group: unknown) => {
    if (isObject(group)) for (const name of Object.keys(group)) targets.push(`#${pointerOf([...prefix, name])}`);
  };
  if (isObject(value["components"])) for (const [section, group] of Object.entries(value["components"])) add(["components", section], group);
  for (const legacy of ["definitions", "parameters", "responses"]) if (typeof value["swagger"] === "string") add([legacy], value[legacy]);
  if (typeof value["asyncapi"] === "string") add(["channels"], value["channels"]);
  return targets;
}
let lastGood: { value: unknown } | null = null;

const kindOfTarget = (target: string) => parsePointer(target.slice(1)).slice(0, -1).join("/");

export function complete(source: string, position: Position): CompletionResult | null {
  const lines = source.split("\n");
  const lineIndex = position.line - 1;
  const line = lines[lineIndex] ?? "";
  const before = line.slice(0, Math.max(0, position.column - 1));
  const after = line.slice(Math.max(0, position.column - 1));
  const at = (column: number): Position => ({ line: position.line, column });

  // $ref: '#/components/schemas/Pe|
  const ref = /\$ref["']?\s*:\s*(["']?)([^"'\s,}]*)$/.exec(before);
  if (ref) {
    const quote = ref[1]!;
    const typed = ref[2]!;
    const rest = /^[^"'\s,}]*/.exec(after)![0];
    const items = referenceTargets(source, lineIndex).map((target) => ({
      label: target,
      // In YAML an unquoted "#" starts a comment, so a bare reference needs quotes.
      insert: quote ? target : `'${target}'`,
      kind: "reference" as const,
      detail: kindOfTarget(target),
      info: null,
    }));
    return { from: at(position.column - typed.length), to: at(position.column + rest.length), items };
  }

  const nav = navigatorFor(source);
  if (!nav || source.trimStart().startsWith("{")) return null;

  // key: val|   → allowed values of that key
  const value = /^(\s*)(-\s+)?(?:'([^']*)'|"([^"]*)"|([^\s'"#:][^#:]*?))\s*:(\s*)([^\s#]*)$/.exec(before);
  if (value) {
    const key = (value[3] ?? value[4] ?? value[5] ?? "").trim();
    const indent = value[1]!.length + (value[2]?.length ?? 0);
    const parent = value[2] ? yamlPathAt(lines, lineIndex, value[1]!.length, true) : yamlPathAt(lines, lineIndex, indent);
    const values = nav.values([...parent, key]);
    if (values.length === 0) return null;
    const typed = value[7]!;
    // Right after the colon: add the space YAML needs before the value.
    const lead = value[6] ? "" : " ";
    const rest = /^[^\s#]*/.exec(after)![0];
    return {
      from: at(position.column - typed.length),
      to: at(position.column + rest.length),
      items: values.map((v) => ({ label: v, insert: `${lead}${v}`, kind: "value" as const, detail: null, info: null })),
    };
  }

  // Start of a key, possibly after "- "  → keys the schema allows here
  const key = /^(\s*)(-\s+)?([\w$.-]*)$/.exec(before);
  if (key && !/:/.test(after)) {
    const indent = key[1]!.length + (key[2]?.length ?? 0);
    const parent = key[2] ? yamlPathAt(lines, lineIndex, key[1]!.length, true) : yamlPathAt(lines, lineIndex, indent);
    const present = siblingKeys(lines, lineIndex, indent);
    const typed = key[3]!;
    const rest = /^[\w$.-]*/.exec(after)![0];
    const items = nav
      .keys(parent)
      .filter((k) => !present.has(k.name))
      .sort((a, b) => Number(b.required) - Number(a.required))
      .map((k) => ({
        label: k.name,
        insert: `${k.name}: `,
        kind: "property" as const,
        detail: [k.type, k.required ? "obligatoria" : null].filter(Boolean).join(" · ") || null,
        info: KEY_DOCS[k.name] ?? null,
      }));
    return items.length ? { from: at(position.column - typed.length), to: at(position.column + rest.length), items } : null;
  }
  return null;
}

/** Explains the key under the cursor, or where a $ref points. */
export function hover(source: string, position: Position): HoverResult | null {
  const doc = load(source);
  const spot = doc.value !== undefined ? doc.at(position) : null;
  if (!spot || spot.pointer === "") return null;
  const segments = parsePointer(spot.pointer);
  const name = segments.at(-1)!;

  if (name === "$ref" && spot.part === "value") {
    let node: unknown = doc.value;
    for (const s of segments) node = isObject(node) || Array.isArray(node) ? (node as Record<string, unknown>)[s] : undefined;
    const target = typeof node === "string" ? node : "";
    if (!target.startsWith("#")) return { range: spot.range, title: target, text: "Referencia a otro archivo; se comprueba con los espacios de trabajo.", type: null };
    let resolved: unknown = doc.value;
    for (const s of parsePointer(decodeURIComponent(target.slice(1)))) resolved = isObject(resolved) || Array.isArray(resolved) ? (resolved as Record<string, unknown>)[s] : undefined;
    const text =
      resolved === undefined
        ? "Esta referencia no existe en el documento."
        : isObject(resolved)
          ? `Objeto con ${Object.keys(resolved).length} ${Object.keys(resolved).length === 1 ? "clave" : "claves"}${typeof resolved["type"] === "string" ? ` · type: ${resolved["type"]}` : ""}. F12 o Ctrl+clic para ir.`
          : "F12 o Ctrl+clic para ir.";
    return { range: spot.range, title: target, text, type: null };
  }

  if (spot.part !== "key") return null;
  const nav = navigatorFor(source);
  const described = nav ? nav.describe(nav.at(segments)) : { type: null, description: null };
  return { range: spot.range, title: name, text: KEY_DOCS[name] ?? null, type: described.type };
}

/** Where a local $ref under the cursor points, or null. */
export function definition(source: string, position: Position): Range | null {
  const doc = load(source);
  if (doc.value === undefined) return null;
  const spot = doc.at(position);
  if (!spot || !spot.pointer.endsWith("/$ref")) return null;
  let node: unknown = doc.value;
  for (const s of parsePointer(spot.pointer)) node = isObject(node) || Array.isArray(node) ? (node as Record<string, unknown>)[s] : undefined;
  if (typeof node !== "string" || !node.startsWith("#")) return null;
  let target: string;
  try {
    target = decodeURIComponent(node.slice(1));
  } catch {
    return null;
  }
  let resolved: unknown = doc.value;
  for (const s of parsePointer(target)) resolved = isObject(resolved) || Array.isArray(resolved) ? (resolved as Record<string, unknown>)[s] : undefined;
  return resolved === undefined ? null : doc.locate(target, "key");
}

/** Path of the node under the cursor, for the breadcrumb. */
export function pathAt(source: string, position: Position): string[] {
  const doc = load(source);
  // In the indentation, the cursor belongs to the key the line starts with.
  const lineText = source.split("\n")[position.line - 1] ?? "";
  const lead = /^[\s-]*/.exec(lineText)![0].length;
  const at = position.column <= lead && lead < lineText.length ? { line: position.line, column: lead + 1 } : position;
  const spot = doc.value !== undefined ? doc.at(at) : null;
  if (spot) return parsePointer(spot.pointer);
  if (source.trimStart().startsWith("{")) return [];
  const lines = source.split("\n");
  const line = lines[position.line - 1] ?? "";
  const key = keyOfLine(line);
  const inItem = /^\s*-\s+/.test(line);
  const path = yamlPathAt(lines, position.line - 1, indentOf(line), inItem);
  return key === null ? path : [...path, key];
}
