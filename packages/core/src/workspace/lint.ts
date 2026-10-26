/**
 * Checks a whole workspace: every version's entry against its official
 * schema and the style guide (APIs only: domains are just shared
 * components), the other files of the version (syntax and references), and
 * published versions whose files changed after publishing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fsReader } from "../refs.js";
import { builtinGuide, loadGuide, type Guide } from "../govern/guide.js";
import type { Diagnostic } from "../source.js";
import { analyzeDocument, type Analysis } from "../validate.js";
import type { Workspace } from "./workspace.js";

export interface FileLint {
  /** Relative to the workspace root. */
  file: string;
  api: string;
  version: string;
  entry: boolean;
  analysis: Analysis;
}

export interface WorkspaceLint {
  files: FileLint[];
  /** Problems that belong to the workspace, not to a line of a file. */
  notes: Array<{ file: string; severity: Diagnostic["severity"]; message: string }>;
}

/** The guide a workspace applies: its own file, or the built-in base. */
export async function workspaceGuide(ws: Workspace): Promise<Guide> {
  if (!ws.guide) return builtinGuide();
  const path = join(ws.root, ws.guide);
  try {
    return loadGuide({ name: path, text: await readFile(path, "utf8") }, fsReader(ws.root));
  } catch {
    const base = builtinGuide();
    return { ...base, problems: [{ guide: path, message: `No se pudo leer ${ws.guide}; se aplica la guía base` }] };
  }
}

export async function lintWorkspace(ws: Workspace, options: { guide?: Guide | null } = {}): Promise<WorkspaceLint> {
  const reader = fsReader(ws.root);
  // null: no guide at all; undefined: the workspace's own.
  const guide = options.guide === null ? undefined : (options.guide ?? (await workspaceGuide(ws)));
  const files: FileLint[] = [];
  const notes: WorkspaceLint["notes"] = ws.problems.map((p) => ({ file: p.file, severity: "error", message: p.message }));
  for (const api of [...ws.apis, ...ws.domains]) {
    for (const version of api.versions) {
      if (version.modified) {
        notes.push({
          file: `${version.dir}/`,
          severity: "error",
          message: `La versión publicada ${api.name} ${version.version} cambió después de publicarse; crea una versión nueva para cambiarla`,
        });
      }
      if (!version.files.includes(version.entry)) {
        notes.push({ file: version.entry, severity: "error", message: `Falta el archivo de entrada de ${api.name} ${version.version}` });
      }
      for (const file of version.files) {
        const absolute = join(ws.root, file);
        const text = await readFile(absolute, "utf8");
        const entry = file === version.entry;
        files.push({ file, api: api.name, version: version.version, entry, analysis: analyzeDocument(text, { file: absolute, reader, fragment: !entry, ...(guide && entry && api.kind === "api" ? { guide } : {}) }) });
      }
    }
  }
  for (const p of guide?.problems ?? []) notes.push({ file: ws.guide ?? "specix:base", severity: "warning", message: p.message });
  return { files, notes };
}
