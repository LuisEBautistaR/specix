import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { basename, join, sep } from "node:path";
import { DEFAULT_BRAND, docModel, exportWorkspaceDocs, loadDocument, loadWorkspace, renderDocsPage, writeAtomic } from "@specix/core";
import { z } from "zod";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import { IpcChannels, type AppInfo, type LangStatus, type WorkspaceView } from "@shared/ipc";
import { MAX_DOCUMENT_CHARS, cursorParams } from "@shared/host-methods";
import { prefsSchema, type Prefs } from "@shared/prefs";
import type { DocumentContext, LangService } from "./lang-service";
import { isTrustedSender } from "./security";
import type { SettingsStore } from "./settings";
import type { UpdateService } from "./updates";
import type { WorkspaceService } from "./workspace-service";

const forbidden: Outcome<never> = { ok: false, error: { code: ErrorCodes.forbidden, message: "Untrusted sender" } };
const invalid = (message: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.invalidParams, message } });
const documentText = z.string().max(MAX_DOCUMENT_CHARS);
/** Workspace-relative paths only: main resolves them and refuses anything outside the workspace. */
const relativePath = z.string().min(1).max(1024).refine((p) => !p.includes("\0") && !/^([a-z]:|[\\/])/i.test(p));
const kind = z.enum(["api", "domain"]);
const slug = z.string().min(1).max(64);
const version = z.string().min(1).max(64);

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
/** Every handler checks the sender first. */
const guarded =
  (run: (...args: unknown[]) => unknown): Handler =>
  (event, ...args) =>
    isTrustedSender(event.senderFrame) ? run(...args) : forbidden;

/** The profile folder as the user may see it: the part under their own account becomes %APPDATA%. */
function profileLabel(): string {
  const appData = app.getPath("appData");
  const profile = app.getPath("userData");
  return profile.startsWith(appData + sep) ? `%APPDATA%${profile.slice(appData.length)}` : profile;
}

interface RouterDeps {
  lang: LangService;
  workspace: WorkspaceService;
  settings: SettingsStore;
  updates: UpdateService;
  testMode: boolean;
}

/** The renderer's only door to main: named channels, trusted sender, validated arguments. */
export function registerIpcRouter({ lang, workspace, settings, updates, testMode }: RouterDeps): void {
  ipcMain.handle(IpcChannels.langStatus, guarded((): LangStatus => lang.status));

  const contextOf = (relative: string, full: string): DocumentContext => ({
    root: workspace.root!,
    file: full,
    fragment: !workspace.isEntry(relative),
    role: workspace.roleOf(relative),
    guide: workspace.guidePath,
  });

  ipcMain.handle(
    IpcChannels.langAnalyze,
    guarded((rawText, rawFile) => {
      const text = documentText.safeParse(rawText);
      if (!text.success) return invalid("Expected a document of at most 5 MB");
      if (rawFile === null || rawFile === undefined) return lang.analyze(text.data);
      const file = relativePath.safeParse(rawFile);
      const full = file.success ? workspace.resolve(file.data) : null;
      // Without a workspace (or with a path outside it) the text is still analysed, just without other files.
      if (!file.success || !full || !workspace.root) return lang.analyze(text.data);
      return lang.analyze(text.data, contextOf(file.data, full));
    }),
  );

  ipcMain.handle(
    IpcChannels.langDocs,
    guarded((rawText, rawFile) => {
      const text = documentText.safeParse(rawText);
      if (!text.success) return invalid("Expected a document of at most 5 MB");
      const file = rawFile === null || rawFile === undefined ? null : relativePath.safeParse(rawFile);
      const full = file?.success ? workspace.resolve(file.data) : null;
      if (!file?.success || !full || !workspace.root) return lang.docs(text.data);
      return lang.docs(text.data, contextOf(file.data, full));
    }),
  );

  // Static documentation site: the whole workspace when one is open, otherwise the given text.
  let lastExport: string | null = null;
  const exportRequest = z.object({
    text: documentText.optional(),
    brand: z.string().min(1).max(100).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    publishedOnly: z.boolean().optional(),
  });
  ipcMain.handle(
    IpcChannels.docsExport,
    guarded(async (raw) => {
      const request = exportRequest.safeParse(raw ?? {});
      if (!request.success) return invalid("Datos no válidos");
      const w = BrowserWindow.getAllWindows()[0];
      const options: Electron.OpenDialogOptions = { title: "Carpeta para la documentación", properties: ["openDirectory", "createDirectory", "promptToCreate"] };
      const picked = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      const dir = picked.filePaths[0];
      if (picked.canceled || !dir) return { ok: true, value: null };
      const brandName = request.data.brand;
      const color = request.data.color ?? DEFAULT_BRAND.color;
      try {
        if (workspace.root) {
          const ws = await loadWorkspace(workspace.root);
          const result = await exportWorkspaceDocs(ws, dir, { brand: { name: brandName ?? ws.name, color, logo: null }, includeDrafts: !request.data.publishedOnly });
          lastExport = join(result.outDir, "index.html");
          return { ok: true, value: { dir: result.outDir, pages: result.pages.length, problems: result.problems.map((p) => `${p.file}: ${p.message}`) } };
        }
        const doc = loadDocument(request.data.text ?? "");
        if (doc.value === undefined) return { ok: false, error: { code: "INVALID_DOCUMENT", message: "El documento tiene errores de sintaxis" } };
        const model = docModel(doc.value);
        lastExport = join(dir, "index.html");
        await writeAtomic(lastExport, renderDocsPage(model, { brand: { name: brandName ?? model.title, color, logo: null } }));
        return { ok: true, value: { dir, pages: 1, problems: [] } };
      } catch (err) {
        return { ok: false, error: { code: "IO_ERROR", message: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );
  ipcMain.handle(
    IpcChannels.docsOpenExport,
    guarded(async () => {
      if (!lastExport) return { ok: false, error: { code: ErrorCodes.notFound, message: "Todavía no se ha exportado nada" } };
      const failure = await shell.openPath(lastExport);
      return failure ? { ok: false, error: { code: "OPEN_FAILED", message: failure } } : { ok: true, value: true };
    }),
  );

  // Editor features: a document plus a cursor, validated here before the host sees it.
  const withCursor = (run: (cursor: z.output<typeof cursorParams>) => Promise<Outcome<unknown>>) =>
    guarded((raw) => {
      const cursor = cursorParams.safeParse(raw);
      return cursor.success ? run(cursor.data) : invalid("Expected { text, line, column }");
    });
  ipcMain.handle(IpcChannels.langComplete, withCursor((c) => lang.complete(c)));
  ipcMain.handle(IpcChannels.langHover, withCursor((c) => lang.hover(c)));
  ipcMain.handle(IpcChannels.langDefinition, withCursor((c) => lang.definition(c)));
  ipcMain.handle(IpcChannels.langPath, withCursor((c) => lang.path(c)));

  ipcMain.handle(IpcChannels.langPing, guarded(() => lang.ping()));
  ipcMain.handle(
    IpcChannels.langCrashHost,
    guarded(() => (testMode ? lang.crashHost() : { ok: false, error: { code: ErrorCodes.unknownMethod, message: "Test hooks are disabled" } })),
  );

  ipcMain.handle(
    IpcChannels.appInfo,
    guarded(
      (): AppInfo => ({
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        profile: profileLabel(),
      }),
    ),
  );

  // ----- Workspace -----
  const window = () => BrowserWindow.getAllWindows()[0];
  ipcMain.handle(IpcChannels.wsGet, guarded(() => workspace.view()));
  ipcMain.handle(
    IpcChannels.wsOpenDialog,
    guarded(async (): Promise<Outcome<WorkspaceView | null>> => {
      const w = window();
      const options: Electron.OpenDialogOptions = { title: "Abrir espacio de trabajo", properties: ["openDirectory"] };
      const picked = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      const dir = picked.filePaths[0];
      return picked.canceled || !dir ? { ok: true, value: null } : workspace.open(dir);
    }),
  );
  ipcMain.handle(
    IpcChannels.wsCreateDialog,
    guarded(async (rawName): Promise<Outcome<WorkspaceView | null>> => {
      const name = z.string().min(1).max(100).optional().safeParse(rawName ?? undefined);
      if (!name.success) return invalid("Nombre no válido");
      const w = window();
      const options: Electron.OpenDialogOptions = { title: "Crear espacio de trabajo en una carpeta vacía", properties: ["openDirectory", "createDirectory", "promptToCreate"] };
      const picked = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      const dir = picked.filePaths[0];
      return picked.canceled || !dir ? { ok: true, value: null } : workspace.create(dir, name.data ?? basename(dir));
    }),
  );
  ipcMain.handle(
    IpcChannels.wsRead,
    guarded((raw) => {
      const path = relativePath.safeParse(raw);
      return path.success ? workspace.read(path.data) : invalid("Ruta no válida");
    }),
  );
  ipcMain.handle(
    IpcChannels.wsWrite,
    guarded((rawPath, rawText) => {
      const path = relativePath.safeParse(rawPath);
      const text = documentText.safeParse(rawText);
      return path.success && text.success ? workspace.write(path.data, text.data) : invalid("Ruta o texto no válidos");
    }),
  );
  const createApi = z.object({ kind, name: slug, template: z.string().max(64).optional(), title: z.string().max(200).optional() });
  ipcMain.handle(
    IpcChannels.wsCreateApi,
    guarded((raw) => {
      const r = createApi.safeParse(raw);
      return r.success ? workspace.createApi(r.data.kind, r.data.name, r.data.template ?? null, r.data.title ?? null) : invalid("Datos no válidos");
    }),
  );
  const newVersion = z.object({ kind, name: slug, from: version, to: version });
  ipcMain.handle(
    IpcChannels.wsCreateVersion,
    guarded((raw) => {
      const r = newVersion.safeParse(raw);
      return r.success ? workspace.createVersion(r.data.kind, r.data.name, r.data.from, r.data.to) : invalid("Datos no válidos");
    }),
  );
  const versionRef = z.object({ kind, name: slug, version });
  ipcMain.handle(
    IpcChannels.wsPublish,
    guarded((raw) => {
      const r = versionRef.safeParse(raw);
      return r.success ? workspace.publish(r.data.kind, r.data.name, r.data.version) : invalid("Datos no válidos");
    }),
  );
  ipcMain.handle(
    IpcChannels.wsSetDefault,
    guarded((raw) => {
      const r = versionRef.safeParse(raw);
      return r.success ? workspace.setDefault(r.data.kind, r.data.name, r.data.version) : invalid("Datos no válidos");
    }),
  );

  const workspaceSettings = z.object({ name: z.string().max(100).optional(), guide: z.string().min(1).max(1024).nullable().optional() });
  ipcMain.handle(
    IpcChannels.wsSettings,
    guarded((raw) => {
      const r = workspaceSettings.safeParse(raw);
      if (!r.success) return invalid("Datos no válidos");
      const { name, guide } = r.data;
      return workspace.updateSettings({ ...(name !== undefined ? { name } : {}), ...(guide !== undefined ? { guide } : {}) });
    }),
  );

  // ----- Preferences of this computer -----
  ipcMain.handle(IpcChannels.prefsGet, guarded((): Prefs => settings.data.prefs));
  ipcMain.handle(
    IpcChannels.prefsSet,
    guarded(async (raw): Promise<Outcome<Prefs>> => {
      const prefs = prefsSchema.safeParse(raw);
      if (!prefs.success) return invalid("Preferencias no válidas");
      await settings.update({ prefs: prefs.data });
      // Electron then answers prefers-color-scheme for the page, and the title bar follows.
      nativeTheme.themeSource = prefs.data.theme;
      broadcast(IpcChannels.prefsChanged, prefs.data);
      return { ok: true, value: prefs.data };
    }),
  );
  ipcMain.handle(
    IpcChannels.prefsRevealProfile,
    guarded(async (): Promise<Outcome<true>> => {
      const failure = await shell.openPath(app.getPath("userData"));
      return failure ? { ok: false, error: { code: "OPEN_FAILED", message: failure } } : { ok: true, value: true };
    }),
  );

  // ----- Updates (packaged builds only) -----
  ipcMain.handle(IpcChannels.updatesGet, guarded(() => updates.state));
  ipcMain.handle(IpcChannels.updatesCheck, guarded(async () => ({ ok: true, value: await updates.check() })));
  ipcMain.handle(
    IpcChannels.updatesInstall,
    guarded(() => {
      updates.install();
      return { ok: true, value: true };
    }),
  );

  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };
  lang.on("status", (status) => broadcast(IpcChannels.langStatusChanged, status));
  workspace.on("changed", (view) => broadcast(IpcChannels.wsChanged, view));
  updates.on("changed", (state) => broadcast(IpcChannels.updatesChanged, state));
}
