import { app, BrowserWindow, nativeTheme } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDevelopmentCsp, registerAppScheme, serveRenderer } from "./protocol";
import { denyPermissions, hardenApp, setDevelopmentOrigin } from "./security";
import { LangService } from "./lang-service";
import { registerIpcRouter } from "./ipc-router";
import { SettingsStore } from "./settings";
import { UpdateService } from "./updates";
import { WorkspaceService } from "./workspace-service";
import { createMainWindow } from "./window";

const mainDir = dirname(fileURLToPath(import.meta.url));
const devUrl = !app.isPackaged ? (process.env["ELECTRON_RENDERER_URL"] ?? null) : null;
/** Test hooks (e.g. crashing the language host on purpose) exist only in unpackaged builds started with SPECIX_TEST=1. */
const testMode = !app.isPackaged && process.env["SPECIX_TEST"] === "1";
// Development and tests can point the app at their own settings folder and workspace.
if (!app.isPackaged && process.env["SPECIX_USER_DATA"]) app.setPath("userData", process.env["SPECIX_USER_DATA"]);
const startWorkspace = !app.isPackaged ? (process.env["SPECIX_WORKSPACE"] ?? null) : null;

const log = (message: string, detail?: unknown): void => {
  if (detail === undefined) console.log(`[main] ${message}`);
  else console.error(`[main] ${message}`, detail);
};

// No fuse covers Chromium's debugging switches: a packaged build refuses to run with them.
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "remote-allow-origins"];
const debugging = DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s) || process.argv.some((arg) => arg === `--${s}` || arg.startsWith(`--${s}=`)));
if (app.isPackaged && debugging) {
  console.error("Specix no se ejecuta con opciones de depuración remota.");
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerAppScheme();
  hardenApp();
  setDevelopmentOrigin(devUrl);

  const lang = new LangService({ hostEntry: join(mainDir, "host.js"), testMode, log });
  const settings = new SettingsStore(app.getPath("userData"));
  const workspace = new WorkspaceService(settings);
  const updates = new UpdateService(log);
  let mainWindow: BrowserWindow | null = null;
  let quitting = false;

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    denyPermissions();
    serveRenderer(join(mainDir, "../renderer"));
    if (devUrl) applyDevelopmentCsp(devUrl);

    registerIpcRouter({ lang, workspace, settings, updates, testMode });
    lang.start();
    // The theme is known before the window exists, so it never flashes the other one.
    const saved = await settings.load();
    nativeTheme.themeSource = saved.prefs.theme;
    // Reopen the last workspace; one that moved or broke just leaves the app without one.
    const dir = startWorkspace ?? (saved.prefs.startup.reopenWorkspace ? saved.lastWorkspace : undefined);
    if (dir) {
      void workspace.open(dir).then((opened) => {
        if (!opened.ok) log(`Could not reopen ${dir}: ${opened.error.message}`);
      });
    }
    mainWindow = createMainWindow(join(mainDir, "../preload/index.cjs"), devUrl);
    mainWindow.on("closed", () => (mainWindow = null));
    if (saved.prefs.startup.checkUpdates) updates.start();
  });

  app.on("window-all-closed", () => app.quit());
  // Let the language host exit cleanly before the app goes away.
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void lang.stop().finally(() => app.quit());
  });
}
