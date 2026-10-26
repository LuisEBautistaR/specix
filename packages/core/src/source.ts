/**
 * Loads an API definition (YAML or JSON) into a plain value plus a map from
 * every JSON Pointer to where it sits in the text, so validation and lint
 * results can point at the exact key or value.
 */
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLError } from "yaml";

/** Lines and columns start at 1, as editors show them. Ranges end where the token ends. */
export interface Position {
  line: number;
  column: number;
}
export interface Range {
  start: Position;
  end: Position;
}

export type Severity = "error" | "warning" | "info" | "hint";
export type DiagnosticSource = "sintaxis" | "estructura" | "referencias" | "guía";

export interface Diagnostic {
  severity: Severity;
  /** Stable id, e.g. "yaml/duplicate-key", "schema/required", "ref/missing". */
  code: string;
  message: string;
  source: DiagnosticSource;
  /** JSON Pointer of the node the diagnostic is about ("" is the root). */
  pointer: string;
  range: Range;
}

export interface LoadedDocument {
  format: "yaml" | "json";
  /** Undefined when the text could not be parsed. */
  value: unknown;
  /** Syntax problems; when there are errors, value is undefined. */
  diagnostics: Diagnostic[];
  /** Where a pointer is in the text; falls back to the nearest ancestor that exists. */
  locate(pointer: string, part?: "key" | "value"): Range;
  /** The innermost key or value under a position, or null outside any node. */
  at(position: Position): { pointer: string; part: "key" | "value"; range: Range } | null;
}

/** Offset of a 1-based line and column, clamped to the text. */
export function offsetOf(source: string, position: Position): number {
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(0, position.column - 1), source.length);
}

/** A few hundred aliases is plenty for real specs; more is the "billion laughs" shape. */
const MAX_ALIASES = 100;

const YAML_MESSAGES: Partial<Record<YAMLError["code"], string>> = {
  DUPLICATE_KEY: "Clave repetida en el mismo objeto",
  BAD_INDENT: "Sangría incorrecta",
  TAB_AS_INDENT: "Tabulador usado como sangría; YAML solo admite espacios",
  MISSING_CHAR: "Falta un carácter de cierre (comilla, corchete o llave)",
  BLOCK_AS_IMPLICIT_KEY: "Una clave no puede ser un bloque de varias líneas",
  MULTILINE_IMPLICIT_KEY: "Una clave sin comillas no puede ocupar varias líneas",
  UNEXPECTED_TOKEN: "Símbolo inesperado",
  BAD_SCALAR_START: "Un valor no puede empezar con este carácter; ponlo entre comillas",
  BAD_DQ_ESCAPE: "Secuencia de escape no válida entre comillas dobles",
  BAD_ALIAS: "Alias no válido",
  ALIAS_PROPS: "Un alias no puede llevar ancla ni etiqueta",
  BLOCK_IN_FLOW: "No se puede abrir un bloque dentro de [ ] o { }",
  KEY_OVER_1024_CHARS: "La clave pasa de 1024 caracteres",
  MULTIPLE_DOCS: "El archivo tiene varios documentos YAML; Specix lee uno por archivo",
  NON_STRING_KEY: "Las claves deben ser texto",
  RESOURCE_EXHAUSTION: "Demasiados alias: el documento crecería sin control",
  TAG_RESOLVE_FAILED: "Etiqueta YAML desconocida",
};

const ESC = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");

export function pointerOf(segments: ReadonlyArray<string | number>): string {
  return segments.map((s) => `/${ESC(String(s))}`).join("");
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function lineAndColumn(source: string, offset: number): Position {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Offset of the first syntax error in a JSON text, for the errors where V8 does
 * not report one ("Unexpected token"). Returns the end of the text if it never
 * finds one.
 */
export function jsonErrorOffset(s: string): number {
  let i = 0;
  const ws = () => {
    while (i < s.length && " \t\n\r".includes(s[i]!)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const literal = (word: string) => (s.startsWith(word, i) ? (i += word.length) : fail());
  const string = () => {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i]! < " ") fail();
      i += s[i] === "\\" ? 2 : 1;
    }
    if (i >= s.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      ws();
      if (s[i] === "}") return void i++;
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        string();
        ws();
        if (s[i] !== ":") fail();
        i++;
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "}") return void i++;
        else fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (s[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "]") return void i++;
        else fail();
      }
    }
    if (c === '"') return string();
    if (c === "t") return void literal("true");
    if (c === "f") return void literal("false");
    if (c === "n") return void literal("null");
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 64));
    if (!number) fail();
    i += number![0].length;
  };
  try {
    value();
    ws();
    return i < s.length ? i : s.length;
  } catch (offset) {
    return offset as number;
  }
}

interface Spot {
  key: [number, number] | null;
  value: [number, number];
}

/** Records the text offsets of every key and value, by JSON Pointer. */
function indexNodes(root: Node | null, spots: Map<string, Spot>): void {
  const visit = (node: unknown, pointer: string, key: [number, number] | null) => {
    const range = (node as Node | null)?.range;
    if (range) spots.set(pointer, { key, value: [range[0], range[1]] });
    else if (key) spots.set(pointer, { key, value: key });
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const k = pair.key;
        const name = isScalar(k) ? String(k.value) : String(k);
        const keyRange = (k as Node | null)?.range ?? null;
        visit(pair.value, `${pointer}/${ESC(name)}`, keyRange ? [keyRange[0], keyRange[1]] : null);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => visit(item, `${pointer}/${i}`, null));
    }
  };
  visit(root, "", null);
}

export function loadDocument(source: string): LoadedDocument {
  const trimmed = source.trimStart();
  const format = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml";
  const spots = new Map<string, Spot>();
  const range = (start: number, end: number): Range => ({ start: lineAndColumn(source, start), end: lineAndColumn(source, Math.max(end, start)) });
  const locate = (pointer: string, part: "key" | "value" = "value"): Range => {
    let p = pointer;
    for (;;) {
      const spot = spots.get(p);
      if (spot) return part === "key" && spot.key ? range(...spot.key) : range(...spot.value);
      if (p === "") return range(0, 0);
      p = p.slice(0, p.lastIndexOf("/"));
    }
  };
  const at = (position: Position) => {
    const offset = offsetOf(source, position);
    let best: { pointer: string; part: "key" | "value"; span: [number, number] } | null = null;
    const consider = (pointer: string, part: "key" | "value", span: [number, number]) => {
      if (offset < span[0] || offset > span[1]) return;
      if (!best || span[1] - span[0] < best.span[1] - best.span[0] || (span[1] - span[0] === best.span[1] - best.span[0] && pointer.length > best.pointer.length)) {
        best = { pointer, part, span };
      }
    };
    for (const [pointer, spot] of spots) {
      if (spot.key) consider(pointer, "key", spot.key);
      consider(pointer, "value", spot.value);
    }
    const found = best as { pointer: string; part: "key" | "value"; span: [number, number] } | null;
    return found ? { pointer: found.pointer, part: found.part, range: range(...found.span) } : null;
  };
  const syntax = (code: string, message: string, start: number, end: number): Diagnostic => ({
    severity: "error",
    code,
    message,
    source: "sintaxis",
    pointer: "",
    range: range(start, end),
  });

  if (trimmed === "") return { format, value: undefined, diagnostics: [syntax("doc/empty", "El documento está vacío", 0, 0)], locate, at };

  if (format === "json") {
    try {
      JSON.parse(source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // V8 gives an offset for most errors but not for "Unexpected token".
      const position = /position (\d+)/.exec(message)?.[1];
      const offset = position !== undefined ? Number(position) : jsonErrorOffset(source);
      return { format, value: undefined, diagnostics: [syntax("json/syntax", "JSON no válido: falta o sobra un símbolo aquí", offset, offset + 1)], locate, at };
    }
  }

  // JSON is valid YAML, so one parser gives positions for both formats.
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true, prettyErrors: false });
  const errors = doc.errors.map((e) => syntax(`yaml/${e.code.toLowerCase().replace(/_/g, "-")}`, YAML_MESSAGES[e.code] ?? `YAML no válido: ${e.message.split("\n")[0]}`, e.pos[0], e.pos[1]));
  if (errors.length) return { format, value: undefined, diagnostics: errors, locate, at };

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch {
    return { format, value: undefined, diagnostics: [syntax("yaml/resource-exhaustion", YAML_MESSAGES.RESOURCE_EXHAUSTION!, 0, 0)], locate, at };
  }
  indexNodes(doc.contents as Node | null, spots);
  return { format, value, diagnostics: [], locate, at };
}
