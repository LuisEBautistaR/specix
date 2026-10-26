import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SPEC } from "@specix/core";
import { parseCli } from "../src/args.js";
import { main, VERSION, type Io } from "../src/main.js";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

describe("parseCli", () => {
  it("reads lint with several files", () => {
    expect(parseCli(["lint", "a.yaml", "b.json", "--json"])).toEqual({ ok: true, command: { kind: "lint", paths: ["a.yaml", "b.json"], format: "json", guide: null, noGuide: false } });
    expect(parseCli(["lint", "a.yaml", "--formato", "sarif", "--guia", "g.yaml"])).toEqual({ ok: true, command: { kind: "lint", paths: ["a.yaml"], format: "sarif", guide: "g.yaml", noGuide: false } });
    expect(parseCli(["lint", "a.yaml", "--formato", "xml"])).toEqual({ ok: false, message: "Formato no válido: xml (usa text, json, sarif o junit)" });
    expect(parseCli(["lint", "a.yaml", "--guia", "g.yaml", "--sin-guia"])).toEqual({ ok: false, message: "--guia y --sin-guia no van juntas" });
  });

  it("reads info with a file and --json", () => {
    expect(parseCli(["info", "api.yaml"])).toEqual({ ok: true, command: { kind: "info", file: "api.yaml", json: false } });
    expect(parseCli(["info", "--json", "api.yaml"])).toEqual({ ok: true, command: { kind: "info", file: "api.yaml", json: true } });
  });

  it("shows help with no command and version on -v", () => {
    expect(parseCli([])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCli(["info", "--help"])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCli(["-v"])).toEqual({ ok: true, command: { kind: "version" } });
  });

  it.each([
    [["info"], "info necesita la ruta de un archivo"],
    [["info", "a.yaml", "b.yaml"], "Argumento inesperado: b.yaml"],
    [["publicar", "a.yaml"], "Comando desconocido: publicar"],
    [["lint"], "lint necesita al menos un archivo o carpeta"],
    [["info", "--quiet", "a.yaml"], "Opción desconocida: --quiet"],
  ])("rejects %j", (argv, message) => {
    expect(parseCli(argv)).toEqual({ ok: false, message });
  });
});

describe("main", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "specix-cli-"));
    await writeFile(join(dir, "tienda.yaml"), DEMO_SPEC);
    await writeFile(join(dir, "roto.yaml"), "openapi: 3.1.0\ninfo:\n  title: A\n  title: B\n");
    await mkdir(join(dir, "carpeta"));
    await writeFile(join(dir, "incompleta.yaml"), "openapi: 3.1.0\ninfo:\n  title: A\npaths: {}\n");
    await writeFile(join(dir, "fallback.yaml"), "asyncapi: 3.9.0\ninfo: {title: E, version: '1'}\n");
    await writeFile(join(dir, "sin-tags.yaml"), ["openapi: 3.1.0", "info: {title: A, version: '1'}", "paths:", "  /a:", "    get:", "      responses: {'200': {description: ok}}", ""].join("\n"));
    await writeFile(join(dir, "estricta.yaml"), ["rules:", "  con-tags:", "    message: Sin etiquetas", "    severity: error", "    given: $.paths[*][get,post]", "    then: {field: tags, function: truthy}", ""].join("\n"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("prints the version", async () => {
    const io = capture();
    expect(await main(["--version"], io)).toBe(0);
    expect(io.lines).toEqual([VERSION]);
  });

  it("describes a valid definition", async () => {
    const io = capture();
    expect(await main(["info", join(dir, "tienda.yaml")], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("Especificación OpenAPI 3.1 (3.1.0)");
    expect(io.lines.join("\n")).toContain("API            Tienda 1.0.0");
    expect(io.lines.at(-1)).toBe("  Sin problemas al leerla.");
  });

  it("reports problems with file:line:column and exit code 1", async () => {
    const io = capture();
    const file = join(dir, "roto.yaml");
    expect(await main(["info", file], io)).toBe(1);
    expect(io.lines.at(-1)).toMatch(new RegExp(`^  ${file.replace(/\\/g, "\\\\")}:4:3  Clave repetida en el mismo objeto`));
  });

  it("writes JSON on request", async () => {
    const io = capture();
    expect(await main(["info", "--json", join(dir, "tienda.yaml")], io)).toBe(0);
    expect(JSON.parse(io.lines.join("\n"))).toMatchObject({ family: "openapi-3.1", operations: 3, problems: [] });
  });

  it("explains unreadable paths", async () => {
    const missing = capture();
    expect(await main(["info", join(dir, "no.yaml")], missing)).toBe(1);
    expect(missing.errors[0]).toMatch(/no se pudo leer .*no\.yaml: no existe$/);
    const folder = capture();
    expect(await main(["info", join(dir, "carpeta")], folder)).toBe(1);
    expect(folder.errors[0]).toMatch(/no es un archivo$/);
  });

  it("lints several files, keeps going and sums up", async () => {
    const io = capture();
    const bad = join(dir, "incompleta.yaml");
    expect(await main(["lint", "--sin-guia", join(dir, "tienda.yaml"), bad, join(dir, "no.yaml")], io)).toBe(1);
    expect(io.lines).toEqual([`${bad}:2:1  error  Falta la propiedad obligatoria «version»  [schema/required]`, "1 error y 0 avisos en 2 archivos (1 sin leer)."]);
    expect(io.errors[0]).toMatch(/no\.yaml: no existe$/);
  });

  it("exits 0 when lint finds only notes", async () => {
    const io = capture();
    expect(await main(["lint", "--sin-guia", join(dir, "tienda.yaml"), join(dir, "fallback.yaml")], io)).toBe(0);
    expect(io.lines.at(-1)).toBe("0 errores y 0 avisos en 2 archivos.");
    expect(io.lines[0]).toMatch(/fallback\.yaml:1:11  info   No hay esquema oficial para AsyncAPI 3\.9\.0/);
  });

  it("writes lint results as JSON", async () => {
    const io = capture();
    expect(await main(["lint", "--json", "--sin-guia", join(dir, "incompleta.yaml")], io)).toBe(1);
    const [result] = (JSON.parse(io.lines.join("\n")) as { files: Array<{ readable: boolean; schema: string; diagnostics: Array<{ code: string; pointer: string }> }> }).files;
    expect(result).toMatchObject({ readable: true, schema: "OpenAPI 3.1 (2026-08-03)", diagnostics: [{ code: "schema/required", pointer: "/info" }] });
  });

  it("applies the base guide to loose files, or the one given", async () => {
    const io = capture();
    const file = join(dir, "sin-tags.yaml");
    expect(await main(["lint", file], io)).toBe(0);
    expect(io.lines).toContain(`${file}:5:5  aviso  La operación no tiene etiquetas  [guia/operation-tags]`);
    expect(io.lines.at(-1)).toBe("0 errores y 5 avisos en 1 archivo.");

    const strict = capture();
    expect(await main(["lint", "--guia", join(dir, "estricta.yaml"), file], strict)).toBe(1);
    expect(strict.lines).toEqual([`${file}:5:5  error  Sin etiquetas  [guia/con-tags]`, "1 error y 0 avisos en 1 archivo."]);

    const missing = capture();
    expect(await main(["lint", "--guia", join(dir, "nada.yaml"), file], missing)).toBe(1);
  });

  it("writes SARIF 2.1.0 and JUnit for CI", async () => {
    const file = join(dir, "sin-tags.yaml");
    const sarif = capture();
    expect(await main(["lint", "--formato", "sarif", "--guia", join(dir, "estricta.yaml"), file, join(dir, "incompleta.yaml")], sarif)).toBe(1);
    const log = JSON.parse(sarif.lines.join("\n")) as { version: string; runs: Array<{ tool: { driver: { name: string; rules: Array<{ id: string }> } }; results: Array<Record<string, unknown>> }> };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]!.tool.driver.name).toBe("Specix");
    expect(log.runs[0]!.tool.driver.rules.map((r) => r.id)).toEqual(["guia/con-tags", "schema/required"]);
    expect(log.runs[0]!.results[0]).toEqual({
      ruleId: "guia/con-tags",
      level: "error",
      message: { text: "Sin etiquetas" },
      locations: [{ physicalLocation: { artifactLocation: { uri: file.split("\\").join("/") }, region: { startLine: 5, startColumn: 5, endLine: 5, endColumn: 8 } } }],
    });

    const junit = capture();
    expect(await main(["lint", "--formato", "junit", "--sin-guia", join(dir, "tienda.yaml"), join(dir, "incompleta.yaml")], junit)).toBe(1);
    const xml = junit.lines.join("\n");
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="specix" tests="2" failures="1">/);
    expect(xml).toContain('<testcase classname="' + join(dir, "tienda.yaml") + '" name="sin problemas"/>');
    expect(xml).toContain('<failure type="error" message="Falta la propiedad obligatoria «version»">');
  });

  it("points usage errors at --help", async () => {
    const io = capture();
    expect(await main(["publicar"], io)).toBe(1);
    expect(io.errors).toEqual(["specix: Comando desconocido: publicar", "Prueba «specix --help»."]);
  });
});
