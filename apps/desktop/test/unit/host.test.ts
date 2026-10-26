import { describe, expect, it } from "vitest";
import { DEMO_SPEC } from "@specix/core";
import type { FromHost } from "@shared/rpc";
import { createHandlers } from "../../src/host/handlers";
import { createRpcServer, HandlerError, type Handlers } from "../../src/host/rpc-server";

function setup(handlers: Handlers, testMode = false) {
  const sent: FromHost[] = [];
  const server = createRpcServer({ handlers, send: (m) => sent.push(m), testMode });
  const call = async (id: string, method: string, params: unknown) => {
    server.handle({ kind: "call", id, method, params });
    await expect.poll(() => sent.find((m) => m.kind === "result" && m.id === id)).toBeDefined();
    return sent.find((m) => m.kind === "result" && m.id === id);
  };
  return { server, sent, call };
}

const pong: Handlers = { "system.ping": (p) => ({ sentAt: (p as { sentAt: number }).sentAt, hostTime: 2, pid: 7, uptimeMs: 1 }) };

describe("host RPC server", () => {
  it("answers a valid call with a validated result", async () => {
    const { call } = setup(pong);
    expect(await call("a", "system.ping", { sentAt: 1 })).toEqual({ kind: "result", id: "a", ok: true, value: { sentAt: 1, hostTime: 2, pid: 7, uptimeMs: 1 } });
  });

  it("rejects methods outside the contract table, and listed methods without a handler", async () => {
    const { call } = setup(pong);
    expect(await call("b", "fs.readFile", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect(await call("b2", "lang.analyze", { text: "" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
  });

  it("rejects invalid params before reaching the handler", async () => {
    let reached = false;
    const { call } = setup({ "system.ping": () => ((reached = true), {}) });
    expect(await call("c", "system.ping", { sentAt: "now" })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(reached).toBe(false);
  });

  it("refuses results that break the contract", async () => {
    const { call } = setup({ "system.ping": () => ({ hacked: true }) });
    expect(await call("d", "system.ping", { sentAt: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_RESULT" } });
  });

  it("passes HandlerError codes through and wraps other exceptions", async () => {
    const { call } = setup({
      "system.ping": () => {
        throw new HandlerError("TOO_BIG", "taken");
      },
      "system.info": () => {
        throw new Error("socket closed");
      },
    });
    expect(await call("e", "system.ping", { sentAt: 1 })).toMatchObject({ ok: false, error: { code: "TOO_BIG", message: "taken" } });
    expect(await call("e2", "system.info", {})).toMatchObject({ ok: false, error: { code: "HANDLER_FAILED", message: "socket closed" } });
  });

  it("cancels an in-flight call", async () => {
    const { server, sent } = setup({
      "system.ping": (_p, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}))),
    });
    server.handle({ kind: "call", id: "f", method: "system.ping", params: { sentAt: 1 } });
    await expect.poll(() => server.inFlight).toBe(1);
    server.handle({ kind: "cancel", id: "f" });
    expect(sent.at(-1)).toMatchObject({ id: "f", ok: false, error: { code: "CANCELLED" } });
  });

  it("does not expose test-only methods outside test mode", async () => {
    const handlers: Handlers = { "diagnostics.crash": () => ({ scheduled: true }) };
    expect(await setup(handlers, false).call("g", "diagnostics.crash", { exitCode: 1 })).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect(await setup(handlers, true).call("g", "diagnostics.crash", { exitCode: 1 })).toMatchObject({ ok: true });
  });

  it("answers malformed envelopes that carry an id", async () => {
    const { call } = setup(pong);
    expect(await call("h", undefined as never, undefined)).toMatchObject({ ok: false, error: { code: "INVALID_ENVELOPE" } });
  });
});

describe("host handlers", () => {
  const exits: number[] = [];
  const handlers = createHandlers({ exit: (c) => exits.push(c) });

  it("analyzes documents through the contract", async () => {
    const { call } = setup(handlers);
    expect(await call("s1", "lang.analyze", { text: DEMO_SPEC })).toMatchObject({
      ok: true,
      value: { format: "yaml", family: "openapi-3.1", title: "Tienda", operations: 3, schema: "OpenAPI 3.1 (2026-08-03)", diagnostics: [] },
    });
    const broken = await call("s2", "lang.analyze", { text: "openapi: 3.1.0\ninfo: [" });
    expect(broken).toMatchObject({ ok: true, value: { family: null, diagnostics: [{ source: "sintaxis", range: { start: { line: 2 } } }] } });
    const invalid = (await call("s3", "lang.analyze", { text: "openapi: 3.1.0\ninfo: {title: A}\npaths: {}\n" })) as { value: { diagnostics: Array<{ code: string; message: string; source: string }> } };
    expect(invalid.value.diagnostics.filter((d) => d.source !== "guía")).toMatchObject([{ code: "schema/required", message: "Falta la propiedad obligatoria «version»" }]);
  });

  it("applies the built-in guide without a workspace and lists its rules", async () => {
    const { call } = setup(handlers);
    const result = (await call("g1", "lang.analyze", { text: "openapi: 3.1.0\ninfo: {title: A, version: '1'}\npaths: {}\n" })) as {
      value: { diagnostics: Array<{ code: string; source: string }>; guide: { name: string; rules: Array<{ name: string; applies: boolean }> } };
    };
    expect(result.value.guide.name).toBe("specix:base");
    expect(result.value.guide.rules.find((r) => r.name === "servers-defined")).toMatchObject({ applies: true });
    expect(result.value.guide.rules.find((r) => r.name === "definitions-unused")).toMatchObject({ applies: false });
    expect(result.value.diagnostics.filter((d) => d.source === "guía").map((d) => d.code)).toEqual(["guia/servers-defined", "guia/info-description", "guia/info-contact"]);
  });

  it("checks guide files as guides and skips the guide for domains", async () => {
    const { call } = setup(handlers);
    const root = process.cwd();
    const guide = await call("g2", "lang.analyze", { text: "rules:\n  r:\n    given: $\n    then: {function: magia}\n", context: { root, file: `${root}/guias/x.yaml`, fragment: false, role: "guide", guide: null } });
    expect(guide).toMatchObject({ ok: true, value: { guide: null, diagnostics: [{ code: "guide/unknown-function", range: { start: { line: 4 } } }] } });
    const domain = await call("g3", "lang.analyze", { text: "openapi: 3.1.0\ninfo: {title: A, version: '1'}\npaths: {}\n", context: { root, file: `${root}/d.yaml`, fragment: false, role: "domain", guide: null } });
    expect(domain).toMatchObject({ ok: true, value: { guide: null, diagnostics: [] } });
  });

  it("refuses documents over the size limit before parsing them", async () => {
    const { call } = setup(handlers);
    expect(await call("s3", "lang.analyze", { text: "x".repeat(5 * 1024 * 1024 + 1) })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await call("s4", "lang.analyze", { text: 42 })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  });

  it("answers ping with its own pid", async () => {
    const { call } = setup(handlers);
    expect(await call("p1", "system.ping", { sentAt: 5 })).toMatchObject({ ok: true, value: { sentAt: 5, pid: process.pid } });
  });

  it("schedules the exit after answering a crash request", async () => {
    const { call } = setup(handlers, true);
    expect(await call("c1", "diagnostics.crash", { exitCode: 3 })).toMatchObject({ ok: true, value: { scheduled: true } });
    await expect.poll(() => exits).toEqual([3]);
  });
});
