import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { stringify } from "yaml";
import {
  FAMILY_LABELS,
  WORKSPACE_FILE,
  analyzeDocument,
  builtinGuide,
  bundle,
  DEFAULT_BRAND,
  createWorkspace,
  docModel,
  exportWorkspaceDocs,
  renderDocsPage,
  writeAtomic,
  type Brand,
  fsReader,
  lintWorkspace,
  loadGuide,
  loadWorkspace,
  publishVersion,
  summarizeDocument,
  workspaceGuide,
  type Analysis,
  type DocumentSummary,
  type Guide,
  type Severity,
} from "@specix/core";
import { HELP, parseCli } from "./args.js";
import { toJunit, toSarif, type LintFile, type LintNote } from "./report.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Larger files are almost certainly not hand-written API definitions. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const SEVERITY_WORD: Record<Severity, string> = { error: "error", warning: "aviso", info: "info", hint: "pista" };

export function formatSummary(file: string, s: DocumentSummary): string[] {
  const spec = s.family ? `${FAMILY_LABELS[s.family]} (${s.specVersion})` : s.specVersion ? `desconocida (${s.specVersion})` : "—";
  const lines = [
    `${file}`,
    `  Formato        ${s.format.toUpperCase()}`,
    `  Especificación ${spec}`,
    `  API            ${s.title ?? "—"}${s.apiVersion ? ` ${s.apiVersion}` : ""}`,
    `  Operaciones    ${s.operations}`,
  ];
  if (s.problems.length === 0) lines.push("  Sin problemas al leerla.");
  for (const p of s.problems) lines.push(`  ${file}:${p.line}:${p.column}  ${p.message}`);
  return lines;
}

/** One line per diagnostic, file:line:column first so terminals and CI turn it into a link. */
export function formatLint(file: string, a: Analysis): string[] {
  return a.diagnostics.map((d) => `${file}:${d.range.start.line}:${d.range.start.column}  ${SEVERITY_WORD[d.severity].padEnd(5)}  ${d.message}  [${d.code}]`);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function readSource(file: string, io: Io): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("no es un archivo");
    if (info.size > MAX_FILE_BYTES) throw new Error(`pesa más de ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return await readFile(file, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "no existe" : err instanceof Error ? err.message : String(err);
    io.err(`specix: no se pudo leer ${file}: ${reason}`);
    return null;
  }
}

/** Runs the CLI and resolves with the exit code: 0 ok, 1 errors found or usage error. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    io.err(`specix: ${parsed.message}`);
    io.err("Prueba «specix --help».");
    return 1;
  }
  const { command } = parsed;
  if (command.kind === "help") {
    io.out(HELP.trimEnd());
    return 0;
  }
  if (command.kind === "version") {
    io.out(VERSION);
    return 0;
  }

  if (command.kind === "info") {
    const source = await readSource(command.file, io);
    if (source === null) return 1;
    const summary = summarizeDocument(source);
    if (command.json) io.out(JSON.stringify({ file: command.file, ...summary }, null, 2));
    else for (const line of formatSummary(command.file, summary)) io.out(line);
    return summary.problems.length === 0 ? 0 : 1;
  }

  if (command.kind === "init") {
    const dir = resolve(command.dir);
    try {
      const ws = await createWorkspace(dir, command.name ?? basename(dir));
      io.out(`Espacio de trabajo «${ws.name}» creado en ${dir}.`);
      io.out(`Plantillas: ${ws.templates.map((t) => t.name).join(", ")}. Abre la carpeta en Specix o crea una API desde la app.`);
      return 0;
    } catch (err) {
      io.err(`specix: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command.kind === "publish") {
    try {
      const ws = await loadWorkspace(command.dir);
      const kind = command.domain ? "domain" : "api";
      const after = await publishVersion(ws, kind, command.api, command.version);
      const version = (kind === "api" ? after.apis : after.domains).find((a) => a.name === command.api)!.versions.find((v) => v.version === command.version)!;
      io.out(`${command.api} ${command.version} publicada${version.isDefault ? " (por defecto)" : ""}. Sus archivos quedan congelados con su huella.`);
      return 0;
    } catch (err) {
      io.err(`specix: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command.kind === "docs") {
    let logo: string | null = null;
    if (command.logo) {
      const type = /\.svg$/i.test(command.logo) ? "image/svg+xml" : /\.png$/i.test(command.logo) ? "image/png" : null;
      if (!type) {
        io.err("specix: el logo debe ser .png o .svg");
        return 1;
      }
      try {
        logo = `data:${type};base64,${(await readFile(command.logo)).toString("base64")}`;
      } catch {
        io.err(`specix: no se pudo leer el logo ${command.logo}`);
        return 1;
      }
    }
    const brandFor = (name: string): Brand => ({ name: command.brand ?? name, color: command.color ?? DEFAULT_BRAND.color, logo });
    if (await isDirectory(command.path)) {
      try {
        const ws = await loadWorkspace(command.path);
        const result = await exportWorkspaceDocs(ws, command.out, { brand: brandFor(ws.name), includeDrafts: !command.publishedOnly });
        for (const p of result.problems) io.err(`specix: ${p.file}: ${p.message}`);
        io.out(`${plural(result.pages.length, "página", "páginas")} en ${result.outDir}. Abre index.html en el navegador.`);
        return result.problems.length ? 1 : 0;
      } catch (err) {
        io.err(`specix: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    const file = resolve(command.path);
    const root = (await findWorkspaceRoot(file)) ?? dirname(file);
    const result = bundle(file, fsReader(root));
    for (const p of result.problems) io.err(`specix: ${relative(process.cwd(), p.file) || p.file}: ${p.message}`);
    if (result.document === null) return 1;
    const model = docModel(result.document);
    const out = join(resolve(command.out), "index.html");
    await writeAtomic(out, renderDocsPage(model, { brand: brandFor(model.title) }));
    io.out(`1 página en ${resolve(command.out)}. Abre index.html en el navegador.`);
    return result.problems.length ? 1 : 0;
  }

  if (command.kind === "bundle") {
    const file = resolve(command.file);
    const root = (await findWorkspaceRoot(file)) ?? dirname(file);
    const result = bundle(file, fsReader(root));
    for (const p of result.problems) io.err(`specix: ${relative(process.cwd(), p.file) || p.file}: ${p.message}`);
    if (result.document === null || result.problems.length) return 1;
    const text = command.format === "json" ? `${JSON.stringify(result.document, null, 2)}\n` : stringify(result.document, { lineWidth: 0 });
    if (command.out) {
      await writeFile(command.out, text, "utf8");
      io.out(`${command.out}: ${plural(result.files.length, "archivo unido", "archivos unidos")}.`);
    } else {
      io.out(text.trimEnd());
    }
    return 0;
  }

  // lint: every path is checked even if an earlier one fails. A workspace folder lints all its versions.
  const results: LintFile[] = [];
  const notes: LintNote[] = [];
  // The guide: --guia for everything, none with --sin-guia, otherwise each workspace's own (or the base).
  let forced: Guide | null | undefined = command.noGuide ? null : undefined;
  if (command.guide) {
    const path = resolve(command.guide);
    const text = await readSource(command.guide, io);
    if (text === null) return 1;
    forced = loadGuide({ name: path, text }, fsReader((await findWorkspaceRoot(path)) ?? dirname(path)));
    for (const p of forced.problems) notes.push({ file: command.guide, severity: "warning", message: p.message });
  }
  const guides = new Map<string, Guide>();
  const guideFor = async (root: string | null): Promise<Guide | null> => {
    if (forced !== undefined) return forced;
    const key = root ?? "";
    if (!guides.has(key)) {
      let guide = builtinGuide();
      if (root) {
        try {
          const ws = await loadWorkspace(root);
          guide = await workspaceGuide(ws);
          for (const p of guide.problems) notes.push({ file: join(relative(process.cwd(), root), ws.guide ?? "").split(sep).join("/"), severity: "warning", message: p.message });
        } catch {
          // An unreadable workspace file is reported when that folder is linted; the file still gets the base guide.
        }
      }
      guides.set(key, guide);
    }
    return guides.get(key)!;
  };
  for (const path of command.paths) {
    if (await isDirectory(path)) {
      try {
        const ws = await loadWorkspace(path);
        const lint = await lintWorkspace(ws, forced === undefined ? {} : { guide: forced });
        for (const f of lint.files) results.push({ file: join(path, f.file).split(sep).join("/"), analysis: f.analysis });
        for (const n of lint.notes) notes.push({ ...n, file: join(path, n.file).split(sep).join("/") });
      } catch (err) {
        io.err(`specix: ${path}: ${err instanceof Error ? err.message : String(err)}`);
        results.push({ file: path, analysis: null });
      }
      continue;
    }
    const source = await readSource(path, io);
    const absolute = resolve(path);
    const wsRoot = await findWorkspaceRoot(absolute);
    const guide = await guideFor(wsRoot);
    results.push({ file: path, analysis: source === null ? null : analyzeDocument(source, { file: absolute, reader: fsReader(wsRoot ?? process.cwd()), ...(guide ? { guide } : {}) }) });
  }
  const all = [...results.flatMap((r) => r.analysis?.diagnostics ?? []), ...notes];
  const errors = all.filter((d) => d.severity === "error").length;
  const warnings = all.filter((d) => d.severity === "warning").length;
  const unreadable = results.filter((r) => r.analysis === null).length;

  if (command.format === "json") {
    io.out(JSON.stringify({ files: results.map(({ file, analysis }) => ({ file, readable: analysis !== null, ...analysis })), notes }, null, 2));
  } else if (command.format === "sarif") {
    io.out(JSON.stringify(toSarif(results, notes, VERSION), null, 2));
  } else if (command.format === "junit") {
    io.out(toJunit(results, notes));
  } else {
    for (const n of notes) io.out(`${n.file}  ${SEVERITY_WORD[n.severity].padEnd(5)}  ${n.message}`);
    for (const { file, analysis } of results) if (analysis) for (const line of formatLint(file, analysis)) io.out(line);
    const checked = results.length - unreadable;
    io.out(`${plural(errors, "error", "errores")} y ${plural(warnings, "aviso", "avisos")} en ${plural(checked, "archivo", "archivos")}${unreadable ? ` (${unreadable} sin leer)` : ""}.`);
  }
  return errors > 0 || unreadable > 0 ? 1 : 0;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest folder above a file that holds specix.workspace.yaml, if any. */
async function findWorkspaceRoot(file: string): Promise<string | null> {
  let dir = dirname(resolve(file));
  for (;;) {
    try {
      await stat(join(dir, WORKSPACE_FILE));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}
