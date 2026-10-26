/**
 * References between files: «paths/pedidos.yaml» or
 * «../../../dominios/comunes/1.0.0/components.yaml#/components/schemas/Dinero».
 * Checks that they resolve, and bundles a multi-file definition into one
 * document. Files are read through a FileReader confined to the workspace;
 * remote references (http/https) are never fetched.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { isObject } from "./detect.js";
import { loadDocument, parsePointer, pointerOf, type Diagnostic, type LoadedDocument } from "./source.js";

export interface FileReader {
  /** Text of an absolute path, or null when it is missing, too big or outside the allowed root. */
  read(path: string): string | null;
  /** Why read() refused a path, for the message. */
  whyNot(path: string): "missing" | "outside" | "too-big";
}

const MAX_REFERENCED_BYTES = 5 * 1024 * 1024;

/** Reads files under one folder only (the workspace). */
export function fsReader(root: string): FileReader {
  const base = resolve(root);
  const inside = (path: string) => {
    const full = resolve(path);
    return full === base || full.startsWith(base + sep);
  };
  return {
    read(path) {
      if (!inside(path)) return null;
      try {
        if (statSync(path).size > MAX_REFERENCED_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    whyNot(path) {
      if (!inside(path)) return "outside";
      try {
        return statSync(path).size > MAX_REFERENCED_BYTES ? "too-big" : "missing";
      } catch {
        return "missing";
      }
    },
  };
}

/** A reader over an in-memory map of absolute paths (tests, and unsaved editor buffers). */
export function memoryReader(files: Record<string, string>, root = "/"): FileReader {
  const normal = new Map(Object.entries(files).map(([k, v]) => [resolve(k), v]));
  const base = resolve(root);
  const inside = (path: string) => resolve(path) === base || resolve(path).startsWith(base + sep);
  return {
    read: (path) => (inside(path) ? (normal.get(resolve(path)) ?? null) : null),
    whyNot: (path) => (inside(path) ? "missing" : "outside"),
  };
}

export interface ParsedRef {
  /** Absolute path of the target file; null for a local "#/…" reference. */
  file: string | null;
  /** JSON Pointer inside the target ("" for the whole file). */
  pointer: string;
}

const isRemote = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref);

/** Splits a $ref into file and pointer, relative to the file that contains it. Remote refs give null. */
export function parseRef(ref: string, fromFile: string): ParsedRef | null {
  if (isRemote(ref)) return null;
  const hash = ref.indexOf("#");
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  let pointer = hash === -1 ? "" : ref.slice(hash + 1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {
    // Left as written: the lookup will simply fail.
  }
  return { file: filePart ? resolve(dirname(fromFile), decodeURI(filePart)) : null, pointer };
}

function valueAt(root: unknown, pointer: string): unknown {
  let node = root;
  for (const segment of parsePointer(pointer)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const docCache = new Map<string, { text: string; doc: LoadedDocument }>();
function loadFile(reader: FileReader, path: string): LoadedDocument | null {
  const text = reader.read(path);
  if (text === null) return null;
  const cached = docCache.get(path);
  if (cached?.text === text) return cached.doc;
  const doc = loadDocument(text);
  docCache.set(path, { text, doc });
  if (docCache.size > 200) docCache.delete(docCache.keys().next().value!);
  return doc;
}

/** A readable name for a referenced file: its path from the referring file, without the climbing "../". */
const shortName = (path: string, fromFile: string) =>
  relative(dirname(resolve(fromFile)), resolve(path)).split(sep).join("/").replace(/^(\.\.\/)+/, "");

/** Diagnostics for every reference to another file that does not resolve. */
export function checkExternalRefs(root: unknown, doc: LoadedDocument, file: string, reader: FileReader): Diagnostic[] {
  const found: Diagnostic[] = [];
  const walk = (node: unknown, segments: Array<string | number>) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, [...segments, i]));
    if (!isObject(node)) return;
    const ref = node["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const pointer = pointerOf([...segments, "$ref"]);
      const range = doc.locate(pointer);
      const parsed = parseRef(ref, file);
      if (parsed === null) {
        found.push({ severity: "info", code: "ref/remote", message: `Referencia remota sin comprobar: Specix no descarga «${ref}»`, source: "referencias", pointer, range });
      } else if (parsed.file) {
        const target = loadFile(reader, parsed.file);
        const name = shortName(parsed.file, file);
        if (target === null) {
          const why = reader.whyNot(parsed.file);
          const message =
            why === "outside" ? `«${ref}» sale del espacio de trabajo` : why === "too-big" ? `«${name}» pesa más de 5 MB` : `No existe el archivo «${name}»`;
          found.push({ severity: "error", code: why === "outside" ? "ref/outside" : "ref/missing-file", message, source: "referencias", pointer, range });
        } else if (target.value === undefined) {
          found.push({ severity: "error", code: "ref/broken-file", message: `«${name}» tiene errores de sintaxis`, source: "referencias", pointer, range });
        } else if (parsed.pointer && valueAt(target.value, parsed.pointer) === undefined) {
          found.push({ severity: "error", code: "ref/missing", message: `No existe «#${parsed.pointer}» en «${name}»`, source: "referencias", pointer, range });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "example" || key.startsWith("x-")) continue;
      walk(value, [...segments, key]);
    }
  };
  walk(root, []);
  return found;
}

export interface BundleResult {
  /** The single-document definition; null if the entry could not be read. */
  document: unknown;
  /** Every file that took part, entry first. */
  files: string[];
  problems: Array<{ file: string; message: string }>;
}

/** Where a referenced component is hoisted in the bundled document, by specification. */
const COMPONENT = /^\/(components\/[^/]+|definitions|parameters|responses)\/([^/]+)$/;

/**
 * Turns a multi-file definition into one document. A reference to a component
 * in another file (…#/components/schemas/X, or #/definitions/X in Swagger 2.0)
 * is copied into the same place of the bundle and pointed at locally; any
 * other external reference is inlined. Local references keep working because
 * they are resolved against the file they were written in.
 */
export function bundle(entry: string, reader: FileReader): BundleResult {
  const entryPath = resolve(entry);
  const rootDoc = loadFile(reader, entryPath);
  const problems: BundleResult["problems"] = [];
  if (!rootDoc || rootDoc.value === undefined) {
    return { document: null, files: [entryPath], problems: [{ file: entryPath, message: rootDoc ? "El archivo tiene errores de sintaxis" : "No se pudo leer el archivo" }] };
  }
  const result = structuredClone(rootDoc.value) as Record<string, unknown>;
  const files = new Set<string>([entryPath]);
  /** "file#pointer" → local pointer in the bundle. */
  const hoisted = new Map<string, string>();

  const place = (section: string, name: string, key: string): string => {
    const parts = section.split("/");
    let holder: Record<string, unknown> = result;
    for (const part of parts) {
      if (!isObject(holder[part])) holder[part] = {};
      holder = holder[part] as Record<string, unknown>;
    }
    let unique = name;
    for (let n = 2; unique in holder && hoisted.get(key) !== pointerOf([...parts, unique]); n++) unique = `${name}_${n}`;
    return pointerOf([...parts, unique]);
  };

  const resolveIn = (node: unknown, file: string, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolveIn(item, file, stack));
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const parsed = parseRef(ref, file);
      // Local references inside the entry already point at the right place.
      if (parsed && !(parsed.file === null && file === entryPath)) {
        const targetFile = parsed.file ?? file;
        // Pointing back into the entry: that is a local reference in the bundle.
        if (targetFile === entryPath) {
          const { $ref: _, ...siblings } = node;
          return { ...(resolveIn(siblings, file, stack) as object), $ref: `#${parsed.pointer}` };
        }
        const key = `${targetFile}#${parsed.pointer}`;
        // A component already copied (or being copied: recursive schemas) is just pointed at.
        const known = hoisted.get(key);
        if (known) {
          const { $ref: _, ...siblings } = node;
          return Object.keys(siblings).length ? { ...(resolveIn(siblings, file, stack) as object), $ref: `#${known}` } : { $ref: `#${known}` };
        }
        if (stack.includes(key)) {
          problems.push({ file, message: `Referencia circular: ${ref}` });
          return node;
        }
        const targetDoc = loadFile(reader, targetFile);
        const value = targetDoc?.value === undefined ? undefined : valueAt(targetDoc.value, parsed.pointer);
        if (value === undefined) {
          problems.push({ file, message: `No se pudo resolver «${ref}»` });
          return node;
        }
        files.add(targetFile);
        const component = COMPONENT.exec(parsed.pointer);
        if (component) {
          let local = hoisted.get(key);
          if (!local) {
            local = place(component[1]!, component[2]!, key);
            hoisted.set(key, local);
            const segments = parsePointer(local);
            let holder: Record<string, unknown> = result;
            for (const s of segments.slice(0, -1)) holder = holder[s] as Record<string, unknown>;
            holder[segments.at(-1)!] = {};
            holder[segments.at(-1)!] = resolveIn(structuredClone(value), targetFile, [...stack, key]);
          }
          const { $ref: _, ...siblings } = node;
          return Object.keys(siblings).length ? { ...resolveIn(siblings, file, stack) as object, $ref: `#${local}` } : { $ref: `#${local}` };
        }
        return resolveIn(structuredClone(value), targetFile, [...stack, key]);
      }
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "example" || k.startsWith("x-") ? v : resolveIn(v, file, stack)]));
  };

  const bundled = resolveIn(result, entryPath, []) as Record<string, unknown>;
  // Hoisted components were written into `result`; copy them across to the walked copy.
  for (const local of hoisted.values()) {
    const segments = parsePointer(local);
    let from: unknown = result;
    let to: Record<string, unknown> = bundled;
    for (const s of segments.slice(0, -1)) {
      from = (from as Record<string, unknown>)[s];
      if (!isObject(to[s])) to[s] = {};
      to = to[s] as Record<string, unknown>;
    }
    to[segments.at(-1)!] = (from as Record<string, unknown>)[segments.at(-1)!];
  }
  return { document: bundled, files: [...files], problems };
}
