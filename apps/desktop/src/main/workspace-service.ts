import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import {
  GUIDES_DIR,
  WorkspaceError,
  createApi,
  createVersion,
  createWorkspace,
  insideWorkspace,
  loadWorkspace,
  publishVersion,
  setDefaultVersion,
  versionOfFile,
  writeAtomic,
  type Workspace,
} from "@specix/core";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { OpenedFile, WorkspaceView } from "@shared/ipc";
import type { SettingsStore } from "./settings";

type Events = { changed: [WorkspaceView | null] };

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function fail(err: unknown): Outcome<never> {
  if (err instanceof WorkspaceError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof Error && "issues" in err) return { ok: false, error: { code: ErrorCodes.invalidParams, message: "Datos no válidos" } };
  return { ok: false, error: { code: "IO_ERROR", message: err instanceof Error ? err.message : String(err) } };
}

/** What the renderer sees of a workspace: names, versions and relative paths only. */
export function viewOf(ws: Workspace): WorkspaceView {
  const group = (items: Workspace["apis"]) =>
    items.map((a) => ({
      name: a.name,
      dir: a.dir,
      defaultVersion: a.defaultVersion,
      versions: a.versions.map((v) => ({ version: v.version, state: v.state, dir: v.dir, entry: v.entry, files: v.files, modified: v.modified, isDefault: v.isDefault })),
    }));
  return { root: ws.root, name: ws.name, apis: group(ws.apis), domains: group(ws.domains), templates: ws.templates, problems: ws.problems, guide: ws.guide, guides: ws.guides };
}

/**
 * The open workspace, owned by main: only main touches the disk. Every path
 * from the renderer is relative and checked to stay inside the workspace.
 */
export class WorkspaceService extends EventEmitter<Events> {
  #ws: Workspace | null = null;
  readonly #settings: SettingsStore;

  constructor(settings: SettingsStore) {
    super();
    this.#settings = settings;
  }

  get root(): string | null {
    return this.#ws?.root ?? null;
  }

  view(): WorkspaceView | null {
    return this.#ws ? viewOf(this.#ws) : null;
  }

  #set(ws: Workspace | null): WorkspaceView | null {
    this.#ws = ws;
    const view = this.view();
    this.emit("changed", view);
    return view;
  }

  async open(dir: string): Promise<Outcome<WorkspaceView>> {
    try {
      const view = this.#set(await loadWorkspace(dir));
      await this.#settings.update({ lastWorkspace: this.#ws!.root });
      return { ok: true, value: view! };
    } catch (err) {
      return fail(err);
    }
  }

  async create(dir: string, name: string): Promise<Outcome<WorkspaceView>> {
    try {
      const view = this.#set(await createWorkspace(dir, name));
      await this.#settings.update({ lastWorkspace: this.#ws!.root });
      return { ok: true, value: view! };
    } catch (err) {
      return fail(err);
    }
  }

  async reload(): Promise<Outcome<WorkspaceView | null>> {
    if (!this.#ws) return { ok: true, value: null };
    try {
      return { ok: true, value: this.#set(await loadWorkspace(this.#ws.root)) };
    } catch (err) {
      return fail(err);
    }
  }

  /** Absolute path of a workspace-relative file, or null if there is no workspace or it escapes it. */
  resolve(relativePath: string): string | null {
    return this.#ws ? insideWorkspace(this.#ws.root, relativePath) : null;
  }

  /** What a file is: a guide under guias/, part of a domain, or anything else (treated as an API). */
  roleOf(relativePath: string): "api" | "domain" | "guide" {
    if (!this.#ws) return "api";
    if (relativePath.startsWith(`${GUIDES_DIR}/`)) return "guide";
    return versionOfFile(this.#ws, relativePath)?.api.kind === "domain" ? "domain" : "api";
  }

  /** Absolute path of the workspace's style guide, or null for the built-in base. */
  get guidePath(): string | null {
    return this.#ws?.guide ? insideWorkspace(this.#ws.root, this.#ws.guide) : null;
  }

  isEntry(relativePath: string): boolean {
    if (!this.#ws) return false;
    const owner = versionOfFile(this.#ws, relativePath);
    return owner === null || owner.version.entry === relativePath;
  }

  async read(relativePath: string): Promise<Outcome<OpenedFile>> {
    const ws = this.#ws;
    const full = this.resolve(relativePath);
    if (!ws || !full) return { ok: false, error: { code: ErrorCodes.forbidden, message: "La ruta queda fuera del espacio de trabajo" } };
    try {
      if ((await stat(full)).size > MAX_FILE_BYTES) return { ok: false, error: { code: "TOO_BIG", message: "El archivo pesa más de 5 MB" } };
      const text = await readFile(full, "utf8");
      const owner = versionOfFile(ws, relativePath);
      return {
        ok: true,
        value: {
          path: relativePath,
          text,
          readOnly: owner?.version.state === "published",
          api: owner ? { kind: owner.api.kind, name: owner.api.name, version: owner.version.version, state: owner.version.state, isDefault: owner.version.isDefault, entry: owner.version.entry === relativePath } : null,
        },
      };
    } catch (err) {
      return fail(err);
    }
  }

  async write(relativePath: string, text: string): Promise<Outcome<{ savedAt: number }>> {
    const ws = this.#ws;
    const full = this.resolve(relativePath);
    if (!ws || !full) return { ok: false, error: { code: ErrorCodes.forbidden, message: "La ruta queda fuera del espacio de trabajo" } };
    const owner = versionOfFile(ws, relativePath);
    if (owner?.version.state === "published") {
      return { ok: false, error: { code: "READ_ONLY", message: `La versión ${owner.version.version} está publicada; crea una versión nueva para cambiarla` } };
    }
    try {
      await writeAtomic(full, text);
      return { ok: true, value: { savedAt: Date.now() } };
    } catch (err) {
      return fail(err);
    }
  }

  async #change(run: (ws: Workspace) => Promise<Workspace>): Promise<Outcome<WorkspaceView>> {
    if (!this.#ws) return { ok: false, error: { code: "NO_WORKSPACE", message: "No hay un espacio de trabajo abierto" } };
    try {
      return { ok: true, value: this.#set(await run(this.#ws))! };
    } catch (err) {
      return fail(err);
    }
  }

  createApi(kind: "api" | "domain", name: string, template: string | null, title: string | null): Promise<Outcome<WorkspaceView>> {
    return this.#change((ws) => createApi(ws, name, { kind, ...(template ? { template } : {}), ...(title ? { title } : {}) }));
  }

  createVersion(kind: "api" | "domain", name: string, from: string, to: string): Promise<Outcome<WorkspaceView>> {
    return this.#change((ws) => createVersion(ws, kind, name, from, to));
  }

  publish(kind: "api" | "domain", name: string, version: string): Promise<Outcome<WorkspaceView>> {
    return this.#change((ws) => publishVersion(ws, kind, name, version));
  }

  setDefault(kind: "api" | "domain", name: string, version: string): Promise<Outcome<WorkspaceView>> {
    return this.#change((ws) => setDefaultVersion(ws, kind, name, version));
  }
}
