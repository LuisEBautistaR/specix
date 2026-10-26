/**
 * Runs the built binary (packages/cli/dist/bin.js) as a real process: what
 * `npm i -g` and CI will execute.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = resolve(import.meta.dirname, "../dist/bin.js");

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [bin, ...args]);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  return new Promise((r) => child.once("close", (code) => r({ code, out, err })));
}

describe("specix binary", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "specix-bin-"));
    const channels = { pedido: { address: "pedido" } };
    const channel = { $ref: "#/channels/pedido" };
    await writeFile(join(dir, "eventos.json"), JSON.stringify({ asyncapi: "3.0.0", info: { title: "Eventos", version: "0.4.0" }, channels, operations: { enviar: { action: "send", channel } } }));
    await writeFile(join(dir, "sin-accion.json"), JSON.stringify({ asyncapi: "3.0.0", info: { title: "Eventos", version: "0.4.0" }, channels, operations: { enviar: { channel } } }));
    await writeFile(join(dir, "roto.json"), '{"openapi": "3.1.0",');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("prints its version", async () => {
    const p = await run(["--version"]);
    expect(p.code).toBe(0);
    expect(p.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help in Spanish", async () => {
    const p = await run(["--help"]);
    expect(p.code).toBe(0);
    expect(p.out).toContain("Uso: specix <comando>");
  });

  it("describes a definition and exits 0", async () => {
    const p = await run(["info", join(dir, "eventos.json")]);
    expect(p.code).toBe(0);
    expect(p.out).toContain("Especificación AsyncAPI 3 (3.0.0)");
    expect(p.out).toContain("Formato        JSON");
  });

  it("lints against the official schema and exits by severity", async () => {
    const ok = await run(["lint", "--sin-guia", join(dir, "eventos.json")]);
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe("0 errores y 0 avisos en 1 archivo.");

    const bad = await run(["lint", join(dir, "sin-accion.json")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/sin-accion\.json:1:\d+  error  Falta la propiedad obligatoria «action»  \[schema\/required\]/);
  });

  it("exits 1 on a broken definition", async () => {
    const p = await run(["info", join(dir, "roto.json")]);
    expect(p.code).toBe(1);
    expect(p.out).toMatch(/roto\.json:1:\d+  JSON no válido/);
  });
});
