/**
 * Reads and changes a workspace on disk: APIs and domains with their
 * versions, templates, publishing (with a fingerprint that freezes the
 * version) and the default version. Every write is atomic (temp + rename).
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  APIS_DIR,
  API_FILE,
  DOMAINS_DIR,
  GUIDES_DIR,
  SLUG,
  TEMPLATES_DIR,
  VERSION,
  WORKSPACE_FILE,
  apiSchema,
  compareVersions,
  workspaceSchema,
  type ApiFile,
} from "./format.js";
import { BUILTIN_TEMPLATES, fillTemplate } from "./templates.js";
import { STARTER_GUIDE } from "../govern/builtin.js";

export interface VersionInfo {
  version: string;
  state: "draft" | "published";
  /** Folder of the version, relative to the workspace root (forward slashes). */
  dir: string;
  /** Entry file, relative to the workspace root. */
  entry: string;
  /** Every file of the version, relative to the workspace root. */
  files: string[];
  publishedAt: string | null;
  /** Published, but its files no longer match the fingerprint taken when it was published. */
  modified: boolean;
  isDefault: boolean;
}

export interface ApiInfo {
  kind: "api" | "domain";
  name: string;
  /** Folder relative to the workspace root. */
  dir: string;
  defaultVersion: string | null;
  versions: VersionInfo[];
}

export interface TemplateInfo {
  name: string;
  /** Relative to the workspace root. */
  file: string;
}

export interface WorkspaceProblem {
  file: string;
  message: string;
}

export interface Workspace {
  root: string;
  name: string;
  /** Style guide file relative to the root, or null for the built-in base guide. */
  guide: string | null;
  /** Every guide file under guias/, relative to the root. */
  guides: string[];
  apis: ApiInfo[];
  domains: ApiInfo[];
  templates: TemplateInfo[];
  problems: WorkspaceProblem[];
}

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

const DEFINITION_FILE = /\.(ya?ml|json)$/i;
const toPosix = (path: string) => path.split(sep).join("/");

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && DEFINITION_FILE.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

/** sha256 over the version's files (paths and contents, line endings normalised). */
export async function fingerprintOf(versionDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(versionDir)) {
    hash.update(toPosix(relative(versionDir, file)));
    hash.update("\0");
    hash.update((await readFile(file, "utf8")).replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readApiFile(file: string): Promise<ApiFile> {
  return apiSchema.parse(parse(await readFile(file, "utf8")) ?? {});
}

async function loadGroup(root: string, folder: string, kind: "api" | "domain", problems: WorkspaceProblem[]): Promise<ApiInfo[]> {
  const base = join(root, folder);
  if (!(await exists(base))) return [];
  const items: ApiInfo[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(base, entry.name);
    const metaFile = join(dir, API_FILE);
    let meta: ApiFile = { kind, versions: {} };
    if (await exists(metaFile)) {
      try {
        meta = await readApiFile(metaFile);
      } catch (err) {
        problems.push({ file: toPosix(relative(root, metaFile)), message: `No se pudo leer: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      }
    }
    // Version folders on disk that api.yaml does not list yet count as drafts.
    const onDisk = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && VERSION.test(e.name)).map((e) => e.name);
    const names = [...new Set([...Object.keys(meta.versions), ...onDisk])].sort(compareVersions);
    const versions: VersionInfo[] = [];
    for (const version of names) {
      const entryMeta = meta.versions[version] ?? { state: "draft" as const, entry: kind === "domain" ? "components.yaml" : "openapi.yaml" };
      const versionDir = join(dir, version);
      if (!(await exists(versionDir))) {
        problems.push({ file: toPosix(relative(root, metaFile)), message: `La versión ${version} no tiene carpeta` });
        continue;
      }
      const files = (await listFiles(versionDir)).map((f) => toPosix(relative(root, f)));
      const modified = entryMeta.state === "published" && entryMeta.fingerprint !== undefined && (await fingerprintOf(versionDir)) !== entryMeta.fingerprint;
      versions.push({
        version,
        state: entryMeta.state,
        dir: toPosix(relative(root, versionDir)),
        entry: toPosix(relative(root, join(versionDir, entryMeta.entry))),
        files,
        publishedAt: entryMeta.publishedAt ?? null,
        modified,
        isDefault: meta.defaultVersion === version,
      });
    }
    items.push({ kind, name: entry.name, dir: toPosix(relative(root, dir)), defaultVersion: meta.defaultVersion ?? null, versions });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads the whole workspace. Fails only if the folder is not a workspace. */
export async function loadWorkspace(rootDir: string): Promise<Workspace> {
  const root = resolve(rootDir);
  const file = join(root, WORKSPACE_FILE);
  if (!(await exists(file))) throw new WorkspaceError("NOT_A_WORKSPACE", `La carpeta no tiene ${WORKSPACE_FILE}`);
  const parsed = workspaceSchema.safeParse(parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new WorkspaceError("INVALID_WORKSPACE", `${WORKSPACE_FILE} no es válido`);
  const problems: WorkspaceProblem[] = [];
  const templates: TemplateInfo[] = [];
  const templatesDir = join(root, TEMPLATES_DIR);
  if (await exists(templatesDir)) {
    for (const entry of await readdir(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const [first] = await listFiles(join(templatesDir, entry.name));
      if (first) templates.push({ name: entry.name, file: toPosix(relative(root, first)) });
    }
  }
  const guidesDir = join(root, GUIDES_DIR);
  const guides = (await exists(guidesDir)) ? (await listFiles(guidesDir)).map((f) => toPosix(relative(root, f))) : [];
  const guide = parsed.data.guide ?? null;
  if (guide !== null && (insideWorkspace(root, guide) === null || !(await exists(join(root, guide))))) {
    problems.push({ file: WORKSPACE_FILE, message: `No existe la guía «${guide}»; se aplica la guía base` });
  }
  return {
    root,
    name: parsed.data.name,
    guide,
    guides,
    apis: await loadGroup(root, APIS_DIR, "api", problems),
    domains: await loadGroup(root, DOMAINS_DIR, "domain", problems),
    templates: templates.sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

/** Creates a workspace in an empty (or new) folder, with the built-in templates. */
export async function createWorkspace(rootDir: string, name: string): Promise<Workspace> {
  const root = resolve(rootDir);
  if (await exists(join(root, WORKSPACE_FILE))) throw new WorkspaceError("ALREADY_A_WORKSPACE", "La carpeta ya es un espacio de trabajo");
  if ((await exists(root)) && (await readdir(root)).some((e) => !e.startsWith("."))) {
    throw new WorkspaceError("FOLDER_NOT_EMPTY", "La carpeta no está vacía; elige una vacía o una nueva");
  }
  await writeAtomic(join(root, WORKSPACE_FILE), stringify({ specix: 1, name, guide: `${GUIDES_DIR}/empresa.yaml` }));
  await writeAtomic(join(root, GUIDES_DIR, "empresa.yaml"), STARTER_GUIDE);
  await mkdir(join(root, APIS_DIR), { recursive: true });
  await mkdir(join(root, DOMAINS_DIR), { recursive: true });
  for (const t of BUILTIN_TEMPLATES) await writeAtomic(join(root, TEMPLATES_DIR, t.name, t.file), t.content);
  await writeAtomic(join(root, ".gitignore"), ".specix/\n");
  return loadWorkspace(root);
}

const nameSchema = z.string().regex(SLUG, "El nombre solo puede tener minúsculas, números y guiones");
const versionName = z.string().regex(VERSION, "La versión debe tener la forma 1.2.3");

function groupDir(kind: "api" | "domain"): string {
  return kind === "api" ? APIS_DIR : DOMAINS_DIR;
}

async function updateApiFile(dir: string, change: (meta: ApiFile) => void): Promise<void> {
  const file = join(dir, API_FILE);
  const meta: ApiFile = (await exists(file)) ? await readApiFile(file) : { kind: "api", versions: {} };
  change(meta);
  await writeAtomic(file, stringify(meta));
}

export interface CreateApiOptions {
  kind?: "api" | "domain";
  /** Template name under plantillas/; without one, the built-in matching the kind is used. */
  template?: string;
  title?: string;
  version?: string;
}

/** Creates an API (or domain) with a first draft version made from a template. */
export async function createApi(ws: Workspace, name: string, opts: CreateApiOptions = {}): Promise<Workspace> {
  const kind = opts.kind ?? "api";
  const slug = nameSchema.safeParse(name);
  if (!slug.success) throw new WorkspaceError("INVALID_NAME", slug.error.issues[0]!.message);
  const version = versionName.safeParse(opts.version ?? "1.0.0");
  if (!version.success) throw new WorkspaceError("INVALID_VERSION", version.error.issues[0]!.message);
  const dir = join(ws.root, groupDir(kind), name);
  if (await exists(dir)) throw new WorkspaceError("ALREADY_EXISTS", `Ya existe «${name}»`);

  let content: string;
  let entry: string;
  if (kind === "domain") {
    entry = "components.yaml";
    content = "openapi: 3.1.0\ninfo:\n  title: __TITULO__\n  version: __VERSION__\ncomponents:\n  schemas: {}\n";
  } else {
    const template = opts.template ?? "rest-basica";
    const found = ws.templates.find((t) => t.name === template);
    const builtin = BUILTIN_TEMPLATES.find((t) => t.name === template);
    if (!found && !builtin) throw new WorkspaceError("TEMPLATE_NOT_FOUND", `No existe la plantilla «${template}»`);
    content = found ? await readFile(join(ws.root, found.file), "utf8") : builtin!.content;
    entry = found ? found.file.split("/").at(-1)! : builtin!.file;
  }
  await writeAtomic(join(dir, version.data, entry), fillTemplate(content, { title: opts.title ?? name, version: version.data }));
  await updateApiFile(dir, (meta) => {
    meta.kind = kind;
    meta.versions[version.data] = { state: "draft", entry };
  });
  return loadWorkspace(ws.root);
}

function findApi(ws: Workspace, kind: "api" | "domain", name: string): ApiInfo {
  const api = (kind === "api" ? ws.apis : ws.domains).find((a) => a.name === name);
  if (!api) throw new WorkspaceError("NOT_FOUND", `No existe «${name}»`);
  return api;
}

/** Copies a version into a new draft. The new version's info.version is updated in the entry file. */
export async function createVersion(ws: Workspace, kind: "api" | "domain", name: string, from: string, to: string): Promise<Workspace> {
  const api = findApi(ws, kind, name);
  const source = api.versions.find((v) => v.version === from);
  if (!source) throw new WorkspaceError("NOT_FOUND", `No existe la versión ${from}`);
  const target = versionName.safeParse(to);
  if (!target.success) throw new WorkspaceError("INVALID_VERSION", target.error.issues[0]!.message);
  if (api.versions.some((v) => v.version === to)) throw new WorkspaceError("ALREADY_EXISTS", `Ya existe la versión ${to}`);

  const targetDir = join(ws.root, api.dir, to);
  await cp(join(ws.root, source.dir), targetDir, { recursive: true, errorOnExist: true, force: false });
  const entryName = source.entry.slice(source.dir.length + 1);
  const entryFile = join(targetDir, entryName);
  const text = await readFile(entryFile, "utf8");
  // Only the first «version:» under «info:» changes; the rest of the file is left byte for byte.
  const block = /^(info:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:[ \t]*)(['"]?)[^'"\r\n]*\2/m;
  const flow = /^(info:[ \t]*\{[^}\n]*?\bversion:[ \t]*)(['"]?)[^,'"}\n]*\2/m;
  const json = /("info"\s*:\s*\{[^}]*?"version"\s*:\s*)"[^"]*"/;
  const updated = block.test(text)
    ? text.replace(block, `$1$2${to}$2`)
    : flow.test(text)
      ? text.replace(flow, `$1$2${to}$2`)
      : text.replace(json, `$1"${to}"`);
  await writeAtomic(entryFile, updated);
  await updateApiFile(join(ws.root, api.dir), (meta) => {
    meta.versions[to] = { state: "draft", entry: entryName };
  });
  return loadWorkspace(ws.root);
}

/** Freezes a version: records its fingerprint; from then on Specix treats it as read-only. */
export async function publishVersion(ws: Workspace, kind: "api" | "domain", name: string, version: string, now = new Date()): Promise<Workspace> {
  const api = findApi(ws, kind, name);
  const info = api.versions.find((v) => v.version === version);
  if (!info) throw new WorkspaceError("NOT_FOUND", `No existe la versión ${version}`);
  if (info.state === "published") throw new WorkspaceError("ALREADY_PUBLISHED", `La versión ${version} ya está publicada`);
  const fingerprint = await fingerprintOf(join(ws.root, info.dir));
  await updateApiFile(join(ws.root, api.dir), (meta) => {
    meta.versions[version] = { state: "published", entry: info.entry.slice(info.dir.length + 1), fingerprint, publishedAt: now.toISOString() };
    meta.defaultVersion ??= version;
  });
  return loadWorkspace(ws.root);
}

export async function setDefaultVersion(ws: Workspace, kind: "api" | "domain", name: string, version: string): Promise<Workspace> {
  const api = findApi(ws, kind, name);
  if (!api.versions.some((v) => v.version === version)) throw new WorkspaceError("NOT_FOUND", `No existe la versión ${version}`);
  await updateApiFile(join(ws.root, api.dir), (meta) => {
    meta.defaultVersion = version;
  });
  return loadWorkspace(ws.root);
}

/**
 * Renames the workspace or changes its style guide (null: the built-in base).
 * Edits specix.workspace.yaml in place, so its comments and other keys stay.
 */
export async function updateWorkspaceSettings(ws: Workspace, change: { name?: string; guide?: string | null }): Promise<Workspace> {
  if (change.name !== undefined && !workspaceSchema.shape.name.safeParse(change.name.trim()).success) {
    throw new WorkspaceError("INVALID_NAME", "El nombre debe tener entre 1 y 100 caracteres");
  }
  if (change.guide !== undefined && change.guide !== null && !ws.guides.includes(change.guide)) {
    throw new WorkspaceError("NOT_FOUND", `No existe la guía «${change.guide}» en ${GUIDES_DIR}/`);
  }
  const file = join(ws.root, WORKSPACE_FILE);
  const doc = parseDocument(await readFile(file, "utf8"));
  if (change.name !== undefined) doc.set("name", change.name.trim());
  if (change.guide !== undefined) {
    if (change.guide === null) doc.delete("guide");
    else doc.set("guide", change.guide);
  }
  await writeAtomic(file, doc.toString());
  return loadWorkspace(ws.root);
}

/** Resolves a workspace-relative path, refusing anything that would leave the workspace. */
export function insideWorkspace(root: string, relativePath: string): string | null {
  if (relativePath.includes("\0")) return null;
  const full = resolve(root, relativePath);
  return full === resolve(root) || full.startsWith(resolve(root) + sep) ? full : null;
}

/** The version a file belongs to, if any (published versions are read-only in the editor). */
export function versionOfFile(ws: Workspace, relativePath: string): { api: ApiInfo; version: VersionInfo } | null {
  for (const api of [...ws.apis, ...ws.domains]) {
    for (const version of api.versions) if (relativePath.startsWith(`${version.dir}/`)) return { api, version };
  }
  return null;
}
