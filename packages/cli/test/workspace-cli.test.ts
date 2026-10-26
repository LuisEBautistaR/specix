import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createApi, loadWorkspace } from "@specix/core";
import { parseCli } from "../src/args.js";
import { main, type Io } from "../src/main.js";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specix-wcli-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("workspace commands: arguments", () => {
  it.each([
    [["init"], { kind: "init", dir: ".", name: null }],
    [["init", "api", "--nombre", "Tienda"], { kind: "init", dir: "api", name: "Tienda" }],
    [["bundle", "a.yaml", "-o", "b.json", "--formato", "json"], { kind: "bundle", file: "a.yaml", out: "b.json", format: "json" }],
    [["publish", "tienda", "1.1.0", "--carpeta", "ws", "--dominio"], { kind: "publish", api: "tienda", version: "1.1.0", dir: "ws", domain: true }],
  ])("parses %j", (argv, command) => {
    expect(parseCli(argv)).toEqual({ ok: true, command });
  });

  it.each([
    [["bundle"], "bundle necesita el archivo de entrada"],
    [["bundle", "a.yaml", "--formato", "xml"], "Formato no válido: xml (usa yaml o json)"],
    [["publish", "tienda"], "publish necesita la API y la versión, por ejemplo: specix publish tienda 1.1.0"],
  ])("rejects %j", (argv, message) => {
    expect(parseCli(argv)).toEqual({ ok: false, message });
  });
});

describe("workspace commands", () => {
  it("inits, lints the whole workspace, publishes and notices later changes", async () => {
    const ws = join(dir, "tienda-ws");
    const init = capture();
    expect(await main(["init", ws, "--nombre", "Tienda demo"], init)).toBe(0);
    expect(init.lines[0]).toBe(`Espacio de trabajo «Tienda demo» creado en ${ws}.`);

    await createApi(await loadWorkspace(ws), "tienda");
    const clean = capture();
    expect(await main(["lint", ws], clean)).toBe(0);
    expect(clean.lines.at(-1)).toBe("0 errores y 0 avisos en 1 archivo.");

    const publish = capture();
    expect(await main(["publish", "tienda", "1.0.0", "--carpeta", ws], publish)).toBe(0);
    expect(publish.lines[0]).toBe("tienda 1.0.0 publicada (por defecto). Sus archivos quedan congelados con su huella.");
    const again = capture();
    expect(await main(["publish", "tienda", "1.0.0", "--carpeta", ws], again)).toBe(1);
    expect(again.errors[0]).toBe("specix: La versión 1.0.0 ya está publicada");

    const entry = join(ws, "apis/tienda/1.0.0/openapi.yaml");
    await writeFile(entry, `${await readFile(entry, "utf8")}# retoque\n`);
    const changed = capture();
    expect(await main(["lint", ws], changed)).toBe(1);
    expect(changed.lines[0]).toMatch(/apis\/tienda\/1\.0\.0\/  error  La versión publicada tienda 1\.0\.0 cambió después de publicarse/);
  });

  it("writes the documentation site of a workspace or a single file", async () => {
    const ws = join(dir, "ws");
    await main(["init", ws], capture());
    await createApi(await loadWorkspace(ws), "tienda", { title: "Tienda" });
    const logo = join(dir, "logo.svg");
    await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

    const site = capture();
    expect(await main(["docs", ws, "-o", join(dir, "sitio"), "--marca", "Mi empresa", "--color", "#223344", "--logo", logo], site)).toBe(0);
    expect(site.lines[0]).toBe(`3 páginas en ${join(dir, "sitio")}. Abre index.html en el navegador.`);
    const page = await readFile(join(dir, "sitio/tienda/1.0.0/index.html"), "utf8");
    expect(page).toContain("Mi empresa");
    expect(page).toContain("--brand: #223344");
    expect(page).toContain('<img src="data:image/svg+xml;base64,');

    const drafts = capture();
    expect(await main(["docs", ws, "-o", join(dir, "vacio"), "--solo-publicadas"], drafts)).toBe(0);
    expect(drafts.lines[0]).toMatch(/^1 página en/);

    const single = capture();
    expect(await main(["docs", join(ws, "apis/tienda/1.0.0/openapi.yaml"), "-o", join(dir, "una")], single)).toBe(0);
    expect(await readFile(join(dir, "una/index.html"), "utf8")).toContain("<h1>Tienda</h1>");

    expect(parseCli(["docs", ws])).toEqual({ ok: false, message: "docs necesita la carpeta de salida: -o <carpeta>" });
    expect(parseCli(["docs", ws, "-o", "x", "--color", "rojo"])).toEqual({ ok: false, message: "Color no válido: rojo (usa #rrggbb)" });
  });

  it("bundles a multi-file definition to YAML or JSON", async () => {
    await writeFile(join(dir, "specix.workspace.yaml"), "specix: 1\nname: x\n");
    await writeFile(join(dir, "openapi.yaml"), "openapi: 3.1.0\ninfo: {title: A, version: '1'}\npaths:\n  /a: {$ref: 'rutas.yaml'}\n");
    await writeFile(join(dir, "rutas.yaml"), "get:\n  responses:\n    '200': {description: ok, content: {application/json: {schema: {$ref: 'esquemas.yaml#/components/schemas/A'}}}}\n");
    await writeFile(join(dir, "esquemas.yaml"), "components:\n  schemas:\n    A: {type: string}\n");

    const yaml = capture();
    expect(await main(["bundle", join(dir, "openapi.yaml")], yaml)).toBe(0);
    const doc = parse(yaml.lines.join("\n"));
    expect(doc.paths["/a"].get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/A" });
    expect(doc.components.schemas.A).toEqual({ type: "string" });

    const out = join(dir, "unido.json");
    const json = capture();
    expect(await main(["bundle", join(dir, "openapi.yaml"), "-o", out, "--formato", "json"], json)).toBe(0);
    expect(json.lines[0]).toBe(`${out}: 3 archivos unidos.`);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(doc);

    const lint = capture();
    expect(await main(["lint", out, join(dir, "openapi.yaml")], lint)).toBe(0);

    await writeFile(join(dir, "rutas.yaml"), "get: {$ref: 'nada.yaml'}\n");
    const broken = capture();
    expect(await main(["bundle", join(dir, "openapi.yaml")], broken)).toBe(1);
    expect(broken.errors[0]).toMatch(/No se pudo resolver «nada\.yaml»/);
  });
});
