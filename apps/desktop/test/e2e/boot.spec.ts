/**
 * Launches the built app (out/) with real Electron and checks the S0 promises:
 * the window opens hardened, the language host runs in its own process and
 * reads the document, the bridge rejects bad calls, and a crashed host comes back.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const shots = resolve(root, "test-results/screens");

async function launch(opts: { testMode: boolean; env?: Record<string, string> }): Promise<{ app: ElectronApplication; win: Page; close(): Promise<void> }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...opts.env };
  delete env["ELECTRON_RENDERER_URL"];
  if (opts.testMode) env["SPECIX_TEST"] = "1";
  else delete env["SPECIX_TEST"];
  // Its own profile, so an installed Specix holding the single-instance lock does not swallow the launch.
  const userData = await mkdtemp(join(tmpdir(), "specix-e2e-"));
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: root, env });
  const win = await app.firstWindow();
  await expect(win.getByTestId("lang-state")).toHaveText("Listo", { timeout: 20_000 });
  await expect(win.getByTestId("spec-family")).toHaveText("OpenAPI 3.1", { timeout: 10_000 });
  return {
    app,
    win,
    close: async () => {
      await app.close();
      await rm(userData, { recursive: true, force: true });
    },
  };
}

test("opens a hardened window and the bridge rejects bad calls", async () => {
  const { app, win, close } = await launch({ testMode: false });
  try {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      // Not in Electron's typings, but it reports the preferences actually applied to the page.
      const contents = w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences };
      const p = contents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag, url: w.webContents.getURL() };
    });
    expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, url: "app://specix/index.html" });

    // The page's own isolation checks live in Ajustes.
    await win.getByTestId("rail-ajustes").click();
    for (const id of ["no-node", "bridge", "csp", "origin"]) {
      await expect(win.getByTestId(`check-${id}`)).toHaveAttribute("data-passed", "true");
    }
    await win.getByTestId("rail-diseno").click();

    // Main validates every argument before anything reaches the host.
    expect(await win.evaluate(() => window.specix.lang.analyze(42 as never))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await win.evaluate(() => window.specix.lang.analyze("x".repeat(5 * 1024 * 1024 + 1)))).toMatchObject({
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
    // Test hooks are off outside test mode.
    expect(await win.evaluate(() => window.specix.lang.crashHost())).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });

    // The page cannot reach the network itself: the CSP only allows its own origin.
    const direct = await win.evaluate(() => fetch("http://127.0.0.1:9/").then(() => "reached", () => "blocked"));
    expect(direct).toBe("blocked");

    // No popups and no navigation away from app://.
    expect(await win.evaluate(() => window.open("https://example.com/") === null)).toBe(true);
    await win.evaluate(() => {
      location.href = "https://example.com/";
    });
    await win.waitForTimeout(500);
    expect(win.url()).toBe("app://specix/index.html");
  } finally {
    await close();
  }
});

test("reads the document in the language host, in its own process", async () => {
  const { app, win, close } = await launch({ testMode: true });
  try {
    const pid = Number(await win.getByTestId("lang-pid").textContent());
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(await app.evaluate(() => process.pid));

    await expect(win.getByTestId("doc-title")).toHaveText("Tienda 1.0.0");
    await expect(win.getByTestId("doc-operations")).toHaveText("3");
    await expect(win.getByTestId("doc-state")).toHaveText("válida según el esquema oficial");
    await expect(win.getByTestId("doc-schema")).toHaveText("OpenAPI 3.1 (2026-08-03)");

    await win.getByTestId("tab-diagnostico").click();
    await win.getByTestId("lang-measure").click();
    await expect(win.getByTestId("lang-ping")).toContainText(" ms");

    // Break the YAML: the problem comes back in Spanish with its line and column.
    const source = win.getByTestId("source");
    await source.fill("openapi: 3.1.0\ninfo:\n  title: A\n  title: B\n");
    await expect(win.getByTestId("problem")).toHaveCount(1);
    await expect(win.getByTestId("problem")).toContainText("Clave repetida en el mismo objeto");
    await expect(win.getByTestId("problem")).toContainText("sintaxis");
    await expect(win.getByTestId("problem")).toContainText("4:3");
    await expect(win.getByTestId("doc-state")).toHaveText("1 error");

    // Valid YAML that breaks the official schema and a local reference.
    const broken = [
      "openapi: 3.1.0",
      "info:",
      "  title: Tienda",
      "paths:",
      "  /pedidos:",
      "    post:",
      "      parameters:",
      "        - {name: id, in: cuerpo, schema: {type: string}}",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema: {$ref: '#/components/schemas/Pedid'}",
      "      responses:",
      "        '201': {description: creado}",
      "components:",
      "  schemas:",
      "    Pedido: {type: object}",
      "",
    ].join("\n");
    await source.fill(broken);
    // The built-in guide adds its own notes; this part is about the schema.
    await win.getByTestId("filter-schema").click();
    await expect(win.getByTestId("problem")).toHaveCount(3);
    await expect(win.getByTestId("problem").nth(0)).toContainText("Falta la propiedad obligatoria «version»");
    await expect(win.getByTestId("problem").nth(1)).toContainText("Valor no permitido; usa uno de: «query», «header», «path», «cookie»");
    await expect(win.getByTestId("problem").nth(2)).toContainText("¿Querías «Pedido»?");
    await expect(win.getByTestId("problem").nth(2)).toContainText("referencias");
    await expect(win.getByTestId("doc-state")).toHaveText("3 errores");

    // Clicking a problem selects its range in the editor.
    await win.getByTestId("problem").nth(2).click();
    await expect(win.getByTestId("problem").nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(win.locator(".cm-host")).toHaveAttribute("data-selected-text", "'#/components/schemas/Pedid'");

    await win.screenshot({ path: resolve(shots, "s1-light.png") });
    await win.emulateMedia({ colorScheme: "dark" });
    await win.waitForTimeout(400);
    await win.screenshot({ path: resolve(shots, "s1-dark.png") });
    await win.emulateMedia({ colorScheme: "light" });

    // AsyncAPI in JSON is recognised and validated too.
    await source.fill(JSON.stringify({ asyncapi: "3.0.0", info: { title: "Eventos", version: "0.4.0" }, operations: { enviar: { action: "send", channel: { $ref: "#/channels/c" } } }, channels: { c: { address: "c" } } }));
    await expect(win.getByTestId("spec-family")).toHaveText("AsyncAPI 3");
    await expect(win.getByTestId("doc-operations")).toHaveText("1");
    await expect(win.getByTestId("doc-schema")).toHaveText("AsyncAPI 3.0.0");
    await expect(win.getByTestId("doc-state")).toHaveText("válida · 3 notas de la guía");
  } finally {
    await close();
  }
});

test("restarts a crashed language host and keeps reading", async () => {
  const { win, close } = await launch({ testMode: true });
  try {
    const firstPid = await win.getByTestId("lang-pid").textContent();
    expect(await win.evaluate(() => window.specix.lang.crashHost())).toEqual({ ok: true, value: { scheduled: true } });

    await expect(win.getByTestId("lang-restarts")).toHaveText("1", { timeout: 15_000 });
    await expect(win.getByTestId("lang-state")).toHaveText("Listo", { timeout: 15_000 });
    await expect(win.getByTestId("lang-pid")).not.toHaveText(firstPid ?? "");

    await win.getByTestId("source").fill("swagger: '2.0'\ninfo: {title: Legado, version: '5.1'}\npaths: {}\n");
    await expect(win.getByTestId("spec-family")).toHaveText("Swagger 2.0");
  } finally {
    await close();
  }
});

test("helps while typing: completion, references, F12, breadcrumb and outline", async () => {
  const { win, close } = await launch({ testMode: true });
  try {
    const editor = win.getByTestId("source");
    const doc = [
      "openapi: 3.1.0",
      "info: {title: Tienda, version: 1.0.0}",
      "components:",
      "  schemas:",
      "    Pedido: {type: object}",
      "    PedidoResumen: {type: object}",
      "paths:",
      "  /pedidos:",
      "    post:",
      "      tags: [pedidos]",
      "      parameters:",
      "        - name: id",
      "          in:",
    ].join("\n");
    await editor.fill(doc);
    await expect(win.getByTestId("outline")).toContainText("Pedido");

    // Allowed values of «in», from the official 3.1 schema.
    await editor.press("Control+End");
    await editor.pressSequentially(" q");
    const list = win.locator(".cm-tooltip-autocomplete");
    const chosen = list.locator("li[aria-selected]");
    // CodeMirror ignores Enter for 75 ms after the list opens, so a quick typist does not accept by accident.
    const accept = async () => {
      await win.waitForTimeout(150);
      await win.keyboard.press("Enter");
    };
    await expect(chosen).toContainText("query");
    await accept();
    await expect(editor).toContainText("in: query");

    // Keys of the parameter object, then a $ref to a component.
    await editor.press("Enter");
    await editor.pressSequentially("sch");
    await expect(chosen).toContainText("schema");
    await accept();
    await editor.pressSequentially("{$ref: '#/components/schemas/Ped");
    await expect(list).toContainText("#/components/schemas/PedidoResumen");
    await expect(chosen).toContainText("#/components/schemas/Pedido");
    await win.screenshot({ path: resolve(shots, "s2-completion.png") });
    await accept();
    await editor.pressSequentially("'}");
    await expect(editor).toContainText("schema: {$ref: '#/components/schemas/Pedido'}");

    // The document is valid once completed, and the outline shows the operation.
    await editor.press("Enter");
    await editor.press("Shift+Tab");
    await editor.press("Shift+Tab");
    await editor.pressSequentially("responses: {'200': {description: ok}}");
    await expect(win.getByTestId("doc-state")).toHaveText(/^válida/);
    await expect(win.getByTestId("outline")).toContainText("POST/pedidos");

    // F12 on the $ref jumps to the component; the breadcrumb follows the cursor.
    await editor.press("ArrowUp");
    await editor.press("End");
    for (let i = 0; i < 5; i++) await editor.press("ArrowLeft");
    await expect(win.getByTestId("crumbs")).toContainText("$ref");
    await editor.press("F12");
    await expect(win.locator(".cm-host")).toHaveAttribute("data-selected-text", "Pedido");
    await expect(win.getByTestId("crumbs")).toContainText("componentsschemasPedido");
    await win.screenshot({ path: resolve(shots, "s2-light.png") });
  } finally {
    await close();
  }
});

test("works on a workspace: files across versions, save, publish, new version and new API", async () => {
  const core = await import("../../../../packages/core/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "specix-e2e-ws-"));
  let ws = await core.createWorkspace(root, "Tienda demo");
  ws = await core.createApi(ws, "tienda", { title: "Tienda" });
  ws = await core.publishVersion(ws, "api", "tienda", "1.0.0");
  ws = await core.createVersion(ws, "api", "tienda", "1.0.0", "1.1.0");
  const entry = join(root, "apis/tienda/1.1.0/openapi.yaml");
  // Version 1.1.0 takes one schema from a second file.
  await writeFile(join(root, "apis/tienda/1.1.0/esquemas.yaml"), "components:\n  schemas:\n    Elemento:\n      type: object\n      properties:\n        id: { type: string }\n");
  await writeFile(entry, (await readFile(entry, "utf8")).replace("items: { $ref: '#/components/schemas/Elemento' }", "items: { $ref: 'esquemas.yaml#/components/schemas/Elemento' }"));

  const { win, close } = await launch({ testMode: false, env: { SPECIX_WORKSPACE: root } });
  win.on("dialog", (d) => void d.accept());
  try {
    await expect(win.getByTestId("ws-name")).toHaveText("Tienda demo");
    await expect(win.getByTestId("file-path")).toHaveText("apis/tienda/1.1.0/openapi.yaml");
    await expect(win.getByTestId("doc-state")).toHaveText("válida según el esquema oficial");
    await expect(win.getByTestId("workspace-tree")).toContainText("esquemas.yaml");

    // A reference to a file that does not exist is reported where it is written.
    const editor = win.getByTestId("source");
    const text = await readFile(entry, "utf8");
    await editor.fill(text.replace("esquemas.yaml#", "nada.yaml#"));
    await expect(win.getByTestId("problem")).toContainText("No existe el archivo «nada.yaml»");
    await editor.fill(text.replace("description: Describe aquí qué ofrece la API.", "description: Catálogo de la tienda."));
    await expect(win.getByTestId("doc-state")).toHaveText("válida según el esquema oficial");
    await editor.press("Control+s");
    await expect(win.getByTestId("notice")).toContainText("Guardado apis/tienda/1.1.0/openapi.yaml");
    expect(await readFile(entry, "utf8")).toContain("description: Catálogo de la tienda.");

    // Published versions open read-only.
    await win.getByTestId("version-tienda-1.0.0").click();
    await expect(win.getByTestId("read-only")).toBeVisible();
    await expect(win.locator(".cm-host")).toHaveAttribute("data-readonly", "true");
    // The cursor of the previous file does not follow into the next one.
    await expect(win.getByTestId("crumbs")).toContainText("Ln 1, Col 1");
    await expect(win.getByTestId("publish")).toHaveCount(0);
    await win.screenshot({ path: resolve(shots, "s3-readonly.png") });

    // Publish 1.1.0, then start 1.2.0 from it.
    await win.getByTestId("version-tienda-1.1.0").click();
    await win.getByTestId("publish").click();
    await expect(win.getByTestId("notice")).toContainText("tienda 1.1.0 publicada");
    await expect(win.getByTestId("read-only")).toBeVisible();
    await win.getByTestId("new-version").click();
    await expect(win.getByTestId("field-version")).toHaveValue("1.2.0");
    await win.getByTestId("dialog-submit").click();
    await expect(win.getByTestId("file-path")).toHaveText("apis/tienda/1.2.0/openapi.yaml");
    await expect(win.getByTestId("api-pill")).toContainText("1.2.0");
    await expect(win.getByTestId("api-pill")).toContainText("borrador");
    expect(await readFile(join(root, "apis/tienda/1.2.0/openapi.yaml"), "utf8")).toContain("version: 1.2.0");

    // A new API from the events template.
    await win.getByTestId("new-api").click();
    await win.getByTestId("field-name").fill("eventos");
    await win.getByTestId("field-template").selectOption("eventos");
    await win.getByTestId("dialog-submit").click();
    await expect(win.getByTestId("file-path")).toHaveText("apis/eventos/1.0.0/asyncapi.yaml");
    await expect(win.getByTestId("spec-family")).toHaveText("AsyncAPI 3");
    await expect(win.getByTestId("doc-state")).toHaveText("válida según el esquema oficial");
    await win.screenshot({ path: resolve(shots, "s3-light.png") });

    const meta = await readFile(join(root, "apis/tienda/api.yaml"), "utf8");
    expect(meta).toMatch(/1\.1\.0:\s*\n\s*state: published/);

    // The Versiones page lists every version and opens any of them in the editor.
    await win.getByTestId("rail-versiones").click();
    const tienda = win.getByTestId("versions-tienda");
    await expect(tienda).toContainText("3 versiones");
    await expect(tienda.locator("tbody tr").first()).toContainText("1.2.0");
    await expect(tienda.locator("tbody tr").first()).toContainText("Borrador");
    await expect(win.getByTestId("versions-eventos")).toContainText("1.0.0");
    await win.screenshot({ path: resolve(shots, "versiones.png") });
    await win.getByTestId("v-open-tienda-1.0.0").click();
    await expect(win.getByTestId("file-path")).toHaveText("apis/tienda/1.0.0/openapi.yaml");
    await expect(win.getByTestId("rail-diseno")).toHaveAttribute("aria-current", "page");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("previews the documentation beside the editor and exports the site", async () => {
  const core = await import("../../../../packages/core/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "specix-e2e-docs-"));
  const out = await mkdtemp(join(tmpdir(), "specix-e2e-site-"));
  let ws = await core.createWorkspace(root, "Tienda demo");
  ws = await core.createApi(ws, "tienda", { title: "Tienda" });
  const { app, win, close } = await launch({ testMode: false, env: { SPECIX_WORKSPACE: root } });
  try {
    await expect(win.getByTestId("docs-title")).toHaveText("Tienda");
    const docs = win.getByTestId("docs");
    await expect(docs).toContainText("elementos");
    await expect(docs).toContainText("/elementos/{id}");

    // The operation under the cursor opens in the preview.
    const editor = win.getByTestId("source");
    await editor.click();
    await editor.press("Control+Home");
    const text = await readFile(join(root, "apis/tienda/1.0.0/openapi.yaml"), "utf8");
    const line = text.split("\n").findIndex((l) => l.includes("operationId: crearElemento")) + 1;
    for (let i = 1; i < line; i++) await editor.press("ArrowDown");
    await editor.press("End");
    const op = win.getByTestId("doc-op-post-elementos");
    await expect(op.locator(".op-head")).toHaveAttribute("aria-expanded", "true");
    await expect(op).toContainText("Cuerpo");
    await expect(op.getByTestId("example").first()).toContainText('"nombre":');
    await win.screenshot({ path: resolve(shots, "s4-light.png") });

    // The contract view opens on the same operation, with an example and its schema.
    await win.getByTestId("view-contract").click();
    const card = win.getByTestId("contract-op-post-elementos");
    await expect(card.locator(".card-head")).toHaveAttribute("aria-expanded", "true");
    const body = card.getByTestId("request-payload");
    await expect(body).toContainText("generado del esquema");
    await expect(body.getByTestId("example")).toContainText('"nombre":');
    await body.getByTestId("view-schema").click();
    await expect(body.locator(".stree")).toContainText("Elemento {");
    await win.getByTestId("view-code").click();
    await expect(win.getByTestId("source")).toBeVisible();

    // Export: the folder dialog is answered from the test.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, out);
    await win.getByTestId("export-docs").click();
    await expect(win.getByTestId("notice")).toContainText(`3 páginas en ${out}`);
    const page = await readFile(join(out, "tienda/1.0.0/index.html"), "utf8");
    expect(page).toContain("<h1>Tienda</h1>");
    expect(page).toContain("Tienda demo");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("Ajustes change the app at once and are kept for the next start", async () => {
  const core = await import("../../../../packages/core/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "specix-e2e-prefs-"));
  let ws = await core.createWorkspace(root, "Tienda demo");
  ws = await core.createApi(ws, "tienda", { title: "Tienda" });
  const { app, win, close } = await launch({ testMode: false, env: { SPECIX_WORKSPACE: root } });
  try {
    await expect(win.getByTestId("ws-name")).toHaveText("Tienda demo");
    await win.getByTestId("rail-ajustes").click();
    await expect(win.getByTestId("rail-ajustes")).toHaveAttribute("aria-current", "page");
    await expect(win.getByTestId("prefs-reset")).toBeDisabled();

    // Theme: main pins it, so the page and the title bar follow.
    await win.getByTestId("theme-dark").click();
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    // Playwright pins the page to light by default; without that, the page sees what main chose.
    await win.emulateMedia({ colorScheme: null });
    await expect.poll(() => win.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);

    // Editor: font size and indentation reach the live editor.
    await win.getByTestId("pref-font-size").fill("15");
    await win.getByTestId("pref-font-size").press("Enter");
    await win.getByTestId("pref-tab-4").click();
    await win.getByTestId("pref-payload-esquema").click();
    await win.screenshot({ path: resolve(shots, "ajustes-oscuro.png") });

    // Workspace: renamed in specix.workspace.yaml, and the title bar follows.
    await win.getByTestId("ws-setting-name").fill("Tienda central");
    await win.getByTestId("ws-setting-name").press("Enter");
    await expect(win.getByTestId("ws-name")).toHaveText("Tienda central");
    await win.getByTestId("ws-setting-guide").selectOption("");
    await expect(win.getByTestId("ws-setting-status")).toContainText("Guía cambiada");
    const wsFile = await readFile(join(root, "specix.workspace.yaml"), "utf8");
    expect(wsFile).toContain("name: Tienda central");
    expect(wsFile).not.toContain("guide:");

    await win.getByTestId("rail-diseno").click();
    const size = await win.locator(".cm-host").evaluate((el) => getComputedStyle(el.shadowRoot!.querySelector(".cm-editor")!).fontSize);
    expect(size).toBe("15px");
    // Bodies open as the schema tree now.
    await win.getByTestId("rail-documentacion").click();
    await expect(win.getByTestId("rail-documentacion")).toHaveAttribute("aria-current", "page");
    await expect(win.getByTestId("view-contract")).toHaveAttribute("aria-pressed", "true");

    // Everything is stored for the next start.
    const profile = await app.evaluate(({ app }) => app.getPath("userData"));
    const stored = await readFile(join(profile, "settings.json"), "utf8");
    expect(JSON.parse(stored).prefs).toMatchObject({ theme: "dark", editor: { fontSize: 15, tabSize: 4 }, reading: { payloadView: "esquema" } });

    await win.getByTestId("rail-ajustes").click();
    await win.getByTestId("prefs-reset").click();
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("applies the workspace style guide and shows it in the governance view", async () => {
  const core = await import("../../../../packages/core/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "specix-e2e-gov-"));
  let ws = await core.createWorkspace(root, "Tienda demo");
  ws = await core.createApi(ws, "tienda", { title: "Tienda" });
  const entry = join(root, "apis/tienda/1.0.0/openapi.yaml");
  const guideFile = join(root, "guias/empresa.yaml");
  const { win, close } = await launch({ testMode: false, env: { SPECIX_WORKSPACE: root } });
  win.on("dialog", (d) => void d.accept());
  try {
    await expect(win.getByTestId("doc-state")).toHaveText("válida según el esquema oficial");

    // The house rule of the starter guide: operationId in camelCase.
    const editor = win.getByTestId("source");
    await editor.fill((await readFile(entry, "utf8")).replace("operationId: listarElementos", "operationId: Listar_Elementos"));
    const problem = win.getByTestId("problem");
    await expect(problem).toHaveCount(1);
    await expect(problem).toContainText("operationId debe ir en camelCase: «Listar_Elementos»");
    await expect(problem).toContainText("guía");
    await win.getByTestId("filter-schema").click();
    await expect(problem).toHaveCount(0);
    await expect(win.getByTestId("problems")).toContainText("Nada en este filtro.");
    await win.getByTestId("filter-guide").click();
    await expect(problem).toHaveCount(1);
    await editor.press("Control+s");
    await expect(win.getByTestId("notice")).toContainText("Guardado");

    // The governance view lists the guide's rules with what fails here.
    await win.getByTestId("rail-gobernanza").click();
    await expect(win.getByTestId("rail-gobernanza")).toHaveAttribute("aria-current", "page");
    await expect(win.getByTestId("guide-name")).toHaveText("guias/empresa.yaml");
    await expect(win.getByTestId("guide-rules")).toContainText("aplican a esta especificación");
    const rule = win.locator('[data-rule="operation-id-camelcase"]');
    await expect(rule).toContainText("Aviso");
    await rule.getByRole("button", { name: "1" }).click();
    await expect(win.locator(".cm-host")).toHaveAttribute("data-selected-text", "operationId");
    await win.getByTestId("rules-failing").click();
    await expect(win.getByTestId("rule")).toHaveCount(1);
    await win.screenshot({ path: resolve(shots, "s5-light.png") });

    // The guide is a file of the workspace: checked as a guide while editing, applied once saved.
    await win.getByTestId("open-guide").click();
    await expect(win.getByTestId("file-path")).toHaveText("guias/empresa.yaml");
    const guideText = await readFile(guideFile, "utf8");
    await editor.fill(guideText.replace("function: casing", "function: magia"));
    await expect(problem).toContainText("Función no admitida: «magia»");
    await editor.fill(guideText.replace("severity: warn", "severity: error"));
    await expect(problem).toHaveCount(0);
    await editor.press("Control+s");
    await expect(win.getByTestId("notice")).toContainText("Guardado guias/empresa.yaml");

    await win.getByTestId("version-tienda-1.0.0").click();
    await expect(win.getByTestId("doc-state")).toHaveText("1 error");
    await expect(rule).toContainText("Error");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
