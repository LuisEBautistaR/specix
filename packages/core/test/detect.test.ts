import { describe, expect, it } from "vitest";
import { DEMO_SPEC, FAMILY_LABELS, jsonErrorOffset, summarizeDocument } from "@specix/core";

describe("summarizeDocument", () => {
  it("reads the demo definition", () => {
    expect(summarizeDocument(DEMO_SPEC)).toEqual({
      format: "yaml",
      family: "openapi-3.1",
      specVersion: "3.1.0",
      title: "Tienda",
      apiVersion: "1.0.0",
      operations: 3,
      problems: [],
    });
  });

  it("recognises every supported family, in YAML and JSON", () => {
    const cases: Array<[string, string]> = [
      ['{"swagger": "2.0", "info": {"title": "Legado", "version": "5.1"}, "paths": {"/a": {"get": {}, "post": {}}}}', "swagger-2.0"],
      ["openapi: 3.0.3\ninfo: {title: A, version: '1'}\npaths: {}", "openapi-3.0"],
      ["openapi: 3.2.0\ninfo: {title: A, version: '1'}", "openapi-3.2"],
      ["asyncapi: 2.6.0\ninfo: {title: Eventos, version: 0.1.0}\nchannels:\n  pedido:\n    publish: {}\n    subscribe: {}", "asyncapi-2"],
      ["asyncapi: 3.0.0\ninfo: {title: Eventos, version: 0.4.0}\noperations:\n  enviar: {}\n  recibir: {}", "asyncapi-3"],
    ];
    for (const [source, family] of cases) expect(summarizeDocument(source).family, source).toBe(family);
    expect(summarizeDocument(cases[0]![0]).format).toBe("json");
    expect(summarizeDocument(cases[0]![0]).operations).toBe(2);
    expect(summarizeDocument(cases[3]![0]).operations).toBe(2);
    expect(summarizeDocument(cases[4]![0]).operations).toBe(2);
    expect(Object.keys(FAMILY_LABELS)).toHaveLength(6);
  });

  it("counts only HTTP methods as operations", () => {
    const source = "openapi: 3.1.0\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    summary: x\n    parameters: []\n    get: {}\n    delete: {}";
    expect(summarizeDocument(source).operations).toBe(2);
  });

  it("points YAML errors at their line and column", () => {
    const summary = summarizeDocument("openapi: 3.1.0\ninfo:\n  title: A\n  title: B\n");
    expect(summary.family).toBeNull();
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]).toMatchObject({ line: 4, column: 3 });
    expect(summary.problems[0]!.message).toBe("Clave repetida en el mismo objeto");
  });

  it("points JSON errors at their line and column", () => {
    const summary = summarizeDocument('{\n  "openapi": "3.1.0",\n  "info": }\n');
    expect(summary.format).toBe("json");
    expect(summary.problems[0]).toMatchObject({ line: 3, column: 11 });
    expect(summary.problems[0]!.message).toMatch(/^JSON no válido/);
  });

  it("locates JSON errors V8 reports without a position", () => {
    expect(jsonErrorOffset('{"a": }')).toBe(6);
    expect(jsonErrorOffset('{"a": [1, 2,]}')).toBe(12);
    expect(jsonErrorOffset('{"a": tru}')).toBe(6);
    expect(jsonErrorOffset('{"a": "x\\"y"} x')).toBe(14);
    expect(jsonErrorOffset('{"a": 1')).toBe(7);
    expect(jsonErrorOffset('{"a": [{"b": -1.5e3}, null, false]}')).toBe(35);
  });

  it("explains documents that are not API definitions", () => {
    expect(summarizeDocument("").problems[0]!.message).toBe("El documento está vacío");
    expect(summarizeDocument("- a\n- b").problems[0]!.message).toBe("La raíz del documento debe ser un objeto");
    expect(summarizeDocument("nombre: tienda").problems[0]!.message).toMatch(/falta «openapi»/);
    const odd = summarizeDocument("openapi: 4.0.0\ninfo: {title: A, version: '1'}");
    expect(odd).toMatchObject({ family: null, specVersion: "4.0.0", title: "A" });
    expect(odd.problems[0]!.message).toBe("Versión de OpenAPI no reconocida: 4.0.0");
  });

  it("does not expand alias bombs", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n");
    const summary = summarizeDocument(`openapi: 3.1.0\n${bomb}`);
    expect(summary.family).toBeNull();
    expect(summary.problems[0]!.message).toBe("Demasiados alias: el documento crecería sin control");
  });
});
