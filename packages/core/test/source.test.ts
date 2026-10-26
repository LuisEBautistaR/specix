import { describe, expect, it } from "vitest";
import { loadDocument, parsePointer, pointerOf } from "@specix/core";

const YAML = `openapi: 3.1.0
info:
  title: Tienda
  version: 1.0.0
paths:
  /productos/{id}:
    get:
      tags: [productos, catálogo]
      responses:
        '200':
          description: El producto
`;

describe("pointers", () => {
  it("escape and unescape ~ and /", () => {
    expect(pointerOf(["paths", "/productos/{id}", "get"])).toBe("/paths/~1productos~1{id}/get");
    expect(pointerOf(["a~b", 0])).toBe("/a~0b/0");
    expect(parsePointer("/paths/~1productos~1{id}/get")).toEqual(["paths", "/productos/{id}", "get"]);
    expect(parsePointer("/a~0b/0")).toEqual(["a~b", "0"]);
    expect(parsePointer("")).toEqual([]);
  });
});

describe("loadDocument", () => {
  it("locates keys and values of a YAML document", () => {
    const doc = loadDocument(YAML);
    expect(doc.diagnostics).toEqual([]);
    expect(doc.locate("/info/title", "key").start).toEqual({ line: 3, column: 3 });
    expect(doc.locate("/info/title").start).toEqual({ line: 3, column: 10 });
    expect(doc.locate("/info/title").end).toEqual({ line: 3, column: 16 });
    expect(doc.locate("/paths/~1productos~1{id}", "key").start).toEqual({ line: 6, column: 3 });
    expect(doc.locate("/paths/~1productos~1{id}/get/tags/1").start).toEqual({ line: 8, column: 25 });
    expect(doc.locate("/paths/~1productos~1{id}/get/responses/200", "key").start).toEqual({ line: 10, column: 9 });
  });

  it("falls back to the nearest existing ancestor", () => {
    const doc = loadDocument(YAML);
    expect(doc.locate("/info/contact/email", "key")).toEqual(doc.locate("/info", "key"));
    expect(doc.locate("/info/contact/email")).toEqual(doc.locate("/info"));
    expect(doc.locate("/nada").start).toEqual({ line: 1, column: 1 });
  });

  it("locates JSON documents through the same map", () => {
    const doc = loadDocument('{\n  "openapi": "3.1.0",\n  "info": {"title": "A", "version": "1"}\n}');
    expect(doc.format).toBe("json");
    expect(doc.value).toMatchObject({ info: { title: "A" } });
    expect(doc.locate("/info/version").start).toEqual({ line: 3, column: 37 });
    expect(doc.locate("/info/version", "key").start).toEqual({ line: 3, column: 26 });
  });

  it("reports YAML problems in Spanish with a range", () => {
    const doc = loadDocument("a: 1\nb:\n\t- x\n");
    expect(doc.value).toBeUndefined();
    expect(doc.diagnostics[0]).toMatchObject({ severity: "error", source: "sintaxis", code: "yaml/tab-as-indent", message: "Tabulador usado como sangría; YAML solo admite espacios" });
    expect(doc.diagnostics[0]!.range.start.line).toBe(3);
  });

  it("reports JSON problems at the offending character", () => {
    const doc = loadDocument('{"a": [1, 2,]}');
    expect(doc.diagnostics).toEqual([
      expect.objectContaining({ code: "json/syntax", range: { start: { line: 1, column: 13 }, end: { line: 1, column: 14 } } }),
    ]);
  });

  it("refuses alias bombs instead of expanding them", () => {
    const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 9; i++) levels.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10).fill(`*${String.fromCharCode(96 + i)}`).join(", ")}]`);
    const doc = loadDocument(levels.join("\n"));
    expect(doc.value).toBeUndefined();
    expect(doc.diagnostics[0]!.code).toBe("yaml/resource-exhaustion");
  });
});
