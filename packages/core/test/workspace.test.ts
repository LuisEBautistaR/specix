import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  WorkspaceError,
  analyzeDocument,
  bundle,
  compareVersions,
  createApi,
  createVersion,
  createWorkspace,
  fillTemplate,
  fsReader,
  insideWorkspace,
  lintWorkspace,
  loadWorkspace,
  memoryReader,
  publishVersion,
  setDefaultVersion,
  updateWorkspaceSettings,
  versionOfFile,
  type Workspace,
} from "@specix/core";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specix-ws-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("workspace lifecycle", () => {
  it("creates a workspace with the built-in templates", async () => {
    const ws = await createWorkspace(join(dir, "nuevo"), "tienda-demo");
    expect(ws.name).toBe("tienda-demo");
    expect(ws.templates.map((t) => t.name)).toEqual(["eventos", "rest-basica"]);
    expect(ws.apis).toEqual([]);
    await expect(createWorkspace(join(dir, "nuevo"), "otra")).rejects.toMatchObject({ code: "ALREADY_A_WORKSPACE" });
    await expect(loadWorkspace(dir)).rejects.toMatchObject({ code: "NOT_A_WORKSPACE" });
  });

  it("renames the workspace and switches its guide, keeping the file's comments", async () => {
    let ws: Workspace = await createWorkspace(dir, "demo");
    const file = join(dir, "specix.workspace.yaml");
    await writeFile(file, `# Ajustes del equipo
${await readFile(file, "utf8")}`);
    ws = await updateWorkspaceSettings(ws, { name: "  Tienda  ", guide: null });
    expect(ws).toMatchObject({ name: "Tienda", guide: null });
    const text = await readFile(file, "utf8");
    expect(text).toContain("# Ajustes del equipo");
    expect(parse(text)).toEqual({ specix: 1, name: "Tienda" });
    ws = await updateWorkspaceSettings(ws, { guide: "guias/empresa.yaml" });
    expect(ws.guide).toBe("guias/empresa.yaml");
    await expect(updateWorkspaceSettings(ws, { guide: "guias/otra.yaml" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateWorkspaceSettings(ws, { name: " " })).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("refuses to create a workspace in a folder with files", async () => {
    await writeFile(join(dir, "nota.txt"), "hola");
    await expect(createWorkspace(dir, "x")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("creates an API from a template, versions it, publishes it and detects changes after publishing", async () => {
    let ws: Workspace = await createWorkspace(dir, "demo");
    ws = await createApi(ws, "tienda", { title: "Tienda: catálogo" });
    const [api] = ws.apis;
    expect(api).toMatchObject({ name: "tienda", dir: "apis/tienda", defaultVersion: null });
    expect(api!.versions).toEqual([
      expect.objectContaining({ version: "1.0.0", state: "draft", entry: "apis/tienda/1.0.0/openapi.yaml", files: ["apis/tienda/1.0.0/openapi.yaml"], modified: false }),
    ]);
    const first = await readFile(join(dir, "apis/tienda/1.0.0/openapi.yaml"), "utf8");
    expect(first).toContain("title: 'Tienda: catálogo'");
    expect(analyzeDocument(first).diagnostics).toEqual([]);

    ws = await publishVersion(ws, "api", "tienda", "1.0.0", new Date("2026-10-25T12:00:00Z"));
    expect(ws.apis[0]!.versions[0]).toMatchObject({ state: "published", publishedAt: "2026-10-25T12:00:00.000Z", isDefault: true });
    await expect(publishVersion(ws, "api", "tienda", "1.0.0")).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });

    ws = await createVersion(ws, "api", "tienda", "1.0.0", "1.1.0");
    const second = await readFile(join(dir, "apis/tienda/1.1.0/openapi.yaml"), "utf8");
    expect(second).toContain("version: 1.1.0");
    expect(second.replace("1.1.0", "1.0.0")).toBe(first);
    expect(ws.apis[0]!.versions.map((v) => `${v.version}:${v.state}`)).toEqual(["1.0.0:published", "1.1.0:draft"]);

    ws = await setDefaultVersion(ws, "api", "tienda", "1.1.0");
    expect(ws.apis[0]!.defaultVersion).toBe("1.1.0");

    // Someone edits the published version behind Specix's back.
    await writeFile(join(dir, "apis/tienda/1.0.0/openapi.yaml"), `${first}# cambio\n`);
    ws = await loadWorkspace(dir);
    expect(ws.apis[0]!.versions[0]!.modified).toBe(true);
    const lint = await lintWorkspace(ws);
    expect(lint.notes).toEqual([expect.objectContaining({ message: expect.stringContaining("cambió después de publicarse") })]);

    const meta = parse(await readFile(join(dir, "apis/tienda/api.yaml"), "utf8"));
    expect(meta).toMatchObject({ kind: "api", defaultVersion: "1.1.0", versions: { "1.0.0": { state: "published", fingerprint: expect.stringMatching(/^sha256:/) } } });
  });

  it("validates names and versions", async () => {
    const ws = await createWorkspace(dir, "demo");
    await expect(createApi(ws, "Mi API")).rejects.toMatchObject({ code: "INVALID_NAME" });
    await expect(createApi(ws, "tienda", { version: "1.0" })).rejects.toMatchObject({ code: "INVALID_VERSION" });
    await expect(createApi(ws, "tienda", { template: "nada" })).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    const withApi = await createApi(ws, "tienda");
    await expect(createApi(withApi, "tienda")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(createVersion(withApi, "api", "tienda", "1.0.0", "1.0.0")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("creates AsyncAPI APIs from the events template and domains", async () => {
    let ws = await createWorkspace(dir, "demo");
    ws = await createApi(ws, "eventos", { template: "eventos" });
    ws = await createApi(ws, "comunes", { kind: "domain" });
    expect(ws.apis[0]!.versions[0]!.entry).toBe("apis/eventos/1.0.0/asyncapi.yaml");
    expect(ws.domains[0]!.versions[0]!.entry).toBe("dominios/comunes/1.0.0/components.yaml");
    const lint = await lintWorkspace(ws);
    expect(lint.files.flatMap((f) => f.analysis.diagnostics)).toEqual([]);
  });

  it("finds the version of a file and keeps paths inside the workspace", async () => {
    const ws = await createApi(await createWorkspace(dir, "demo"), "tienda");
    expect(versionOfFile(ws, "apis/tienda/1.0.0/openapi.yaml")?.version.version).toBe("1.0.0");
    expect(versionOfFile(ws, "plantillas/rest-basica/openapi.yaml")).toBeNull();
    expect(insideWorkspace(dir, "apis/tienda/api.yaml")).toBe(join(dir, "apis/tienda/api.yaml"));
    expect(insideWorkspace(dir, "../fuera.yaml")).toBeNull();
    expect(insideWorkspace(dir, "C:/Windows/win.ini")).toBeNull();
  });
});

describe("helpers", () => {
  it("orders versions semantically", () => {
    expect(["1.10.0", "1.2.0", "1.2.0-beta.1", "0.9.0"].sort(compareVersions)).toEqual(["0.9.0", "1.2.0-beta.1", "1.2.0", "1.10.0"]);
  });
  it("quotes titles so they stay valid YAML", () => {
    expect(fillTemplate("title: __TITULO__\nversion: __VERSION__", { title: "O'Reilly: libros", version: "2.0.0" })).toBe("title: 'O''Reilly: libros'\nversion: 2.0.0");
  });
});

describe("references between files", () => {
  const root = "/ws";
  const entry = "/ws/apis/tienda/1.0.0/openapi.yaml";
  const files: Record<string, string> = {
    [entry]: [
      "openapi: 3.1.0",
      "info: {title: Tienda, version: 1.0.0}",
      "paths:",
      "  /pedidos:",
      "    $ref: 'paths/pedidos.yaml'",
      "components:",
      "  schemas:",
      "    Pedido:",
      "      type: object",
      "      properties:",
      "        total: {$ref: '../../../dominios/comunes/1.0.0/components.yaml#/components/schemas/Dinero'}",
      "        cliente: {$ref: '#/components/schemas/Cliente'}",
      "    Cliente: {type: object}",
    ].join("\n"),
    "/ws/apis/tienda/1.0.0/paths/pedidos.yaml": [
      "get:",
      "  responses:",
      "    '200':",
      "      description: ok",
      "      content:",
      "        application/json:",
      "          schema: {$ref: '../openapi.yaml#/components/schemas/Pedido'}",
    ].join("\n"),
    "/ws/dominios/comunes/1.0.0/components.yaml": [
      "openapi: 3.1.0",
      "info: {title: Comunes, version: 1.0.0}",
      "components:",
      "  schemas:",
      "    Dinero:",
      "      type: object",
      "      properties:",
      "        moneda: {$ref: '#/components/schemas/Moneda'}",
      "        siguiente: {$ref: '#/components/schemas/Dinero'}",
      "    Moneda: {type: string, enum: [MXN, USD]}",
    ].join("\n"),
  };
  const reader = memoryReader(files, root);

  it("accepts references that resolve, in entries and in fragments", () => {
    expect(analyzeDocument(files[entry]!, { file: entry, reader }).diagnostics).toEqual([]);
    const fragment = "/ws/apis/tienda/1.0.0/paths/pedidos.yaml";
    expect(analyzeDocument(files[fragment]!, { file: fragment, reader, fragment: true }).diagnostics).toEqual([]);
  });

  it("explains references that do not resolve", () => {
    const broken = files[entry]!
      .replace("'paths/pedidos.yaml'", "'paths/pagos.yaml'")
      .replace("#/components/schemas/Dinero'", "#/components/schemas/Moneda2'")
      .replace("cliente: {$ref: '#/components/schemas/Cliente'}", "cliente: {$ref: '../../../../fuera.yaml'}\n        remoto: {$ref: 'https://ejemplo.test/x.yaml'}");
    const messages = analyzeDocument(broken, { file: entry, reader }).diagnostics.map((d) => `${d.severity} ${d.message}`);
    expect(messages).toEqual([
      "error No existe el archivo «paths/pagos.yaml»",
      "error No existe «#/components/schemas/Moneda2» en «dominios/comunes/1.0.0/components.yaml»",
      "error «../../../../fuera.yaml» sale del espacio de trabajo",
      "info Referencia remota sin comprobar: Specix no descarga «https://ejemplo.test/x.yaml»",
    ]);
  });

  it("bundles into one valid document, copying components and inlining the rest", () => {
    const result = bundle(entry, reader);
    expect(result.problems).toEqual([]);
    expect(result.files).toHaveLength(3);
    const doc = result.document as Record<string, any>;
    expect(doc.paths["/pedidos"].get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Pedido" });
    expect(doc.components.schemas.Pedido.properties.total).toEqual({ $ref: "#/components/schemas/Dinero" });
    expect(doc.components.schemas.Dinero.properties).toEqual({ moneda: { $ref: "#/components/schemas/Moneda" }, siguiente: { $ref: "#/components/schemas/Dinero" } });
    expect(doc.components.schemas.Moneda).toEqual({ type: "string", enum: ["MXN", "USD"] });
    expect(analyzeDocument(JSON.stringify(doc)).diagnostics).toEqual([]);
  });

  it("renames a copied component that collides with one of the entry", () => {
    const clash = { ...files, [entry]: files[entry]!.replace("    Cliente: {type: object}", "    Cliente: {type: object}\n    Dinero: {type: number}") };
    const doc = bundle(entry, memoryReader(clash, root)).document as Record<string, any>;
    expect(doc.components.schemas.Dinero).toEqual({ type: "number" });
    expect(doc.components.schemas.Pedido.properties.total).toEqual({ $ref: "#/components/schemas/Dinero_2" });
    expect(doc.components.schemas.Dinero_2.properties.siguiente).toEqual({ $ref: "#/components/schemas/Dinero_2" });
  });

  it("reads real files through fsReader, refusing paths outside the root", async () => {
    await writeFile(join(dir, "a.yaml"), "x: 1");
    const fsr = fsReader(dir);
    expect(fsr.read(join(dir, "a.yaml"))).toBe("x: 1");
    expect(fsr.read(join(dir, "..", "otro.yaml"))).toBeNull();
    expect(fsr.whyNot(join(dir, "..", "otro.yaml"))).toBe("outside");
    expect(fsr.whyNot(join(dir, "b.yaml"))).toBe("missing");
  });
});
