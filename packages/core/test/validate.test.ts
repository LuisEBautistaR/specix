import { describe, expect, it } from "vitest";
import { DEMO_SPEC, analyzeDocument, schemaFor, suggest, type Analysis } from "@specix/core";

const messages = (a: Analysis) => a.diagnostics.map((d) => `${d.range.start.line}:${d.range.start.column} ${d.message}`);

describe("analyzeDocument: valid documents", () => {
  it("passes the demo definition with the 3.1 schema", () => {
    const a = analyzeDocument(DEMO_SPEC);
    expect(a.schema).toBe("OpenAPI 3.1 (2026-08-03)");
    expect(a.diagnostics).toEqual([]);
  });

  it.each([
    ["swagger: '2.0'\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok}\n", "Swagger 2.0 (2017-08-27)"],
    ["openapi: 3.0.3\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    get:\n      parameters:\n        - {name: q, in: query, schema: {type: string}}\n      responses:\n        '200': {description: ok}\n", "OpenAPI 3.0 (2024-10-18)"],
    ["openapi: 3.2.0\ninfo: {title: A, version: '1'}\npaths: {}\n", "OpenAPI 3.2 (2026-08-30)"],
    ["asyncapi: 2.6.0\ninfo: {title: E, version: '1'}\nchannels:\n  pedido:\n    publish:\n      message: {payload: {type: object}}\n", "AsyncAPI 2.6.0"],
    ["asyncapi: 3.0.0\ninfo: {title: E, version: '1'}\nchannels:\n  pedido: {address: pedido}\noperations:\n  enviar:\n    action: send\n    channel: {$ref: '#/channels/pedido'}\n", "AsyncAPI 3.0.0"],
  ])("accepts %#", (source, schema) => {
    const a = analyzeDocument(source);
    expect(a.schema).toBe(schema);
    expect(messages(a)).toEqual([]);
  });

  it("validates Schema Objects of 3.1 (JSON Schema 2020-12 keywords included)", () => {
    const source = `openapi: 3.1.0
info: {title: A, version: '1'}
components:
  schemas:
    Precio:
      type: [number, 'null']
      exclusiveMinimum: 0
      examples: [10.5]
    Producto:
      type: object
      properties:
        precio: {$ref: '#/components/schemas/Precio'}
      unevaluatedProperties: false
`;
    expect(messages(analyzeDocument(source))).toEqual([]);
  });
});

describe("analyzeDocument: problems", () => {
  const broken = `openapi: 3.1.0
info:
  title: Tienda
paths:
  productos:
    get:
      responses:
        '200': {description: ok}
  /pedidos:
    post:
      parameters:
        - name: id
          in: cuerpo
      requestBody:
        content:
          application/json:
            schema: {$ref: '#/components/schemas/Pedid'}
      responses:
        '201': {description: creado}
components:
  schemas:
    Pedido: {type: object}
`;

  it("explains each problem once, in Spanish, at the right place", () => {
    expect(messages(analyzeDocument(broken))).toEqual([
      "2:1 Falta la propiedad obligatoria «version»",
      "5:3 Propiedad no permitida aquí: «productos»: las rutas deben empezar por «/»",
      "12:11 Falta una de estas propiedades: «schema» o «content»",
      "13:15 Valor no permitido; usa uno de: «query», «header», «path», «cookie»",
      "17:28 La referencia «#/components/schemas/Pedid» no existe. ¿Querías «Pedido»?",
    ]);
  });

  it("tags each diagnostic with its source and code", () => {
    const a = analyzeDocument(broken);
    expect(a.diagnostics.map((d) => [d.source, d.code])).toEqual([
      ["estructura", "schema/required"],
      ["estructura", "schema/unevaluatedProperties"],
      ["estructura", "schema/required"],
      ["estructura", "schema/enum"],
      ["referencias", "ref/missing"],
    ]);
    expect(a.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  it("names types in Spanish and hides the Reference Object alternative", () => {
    const a = analyzeDocument("openapi: 3.0.3\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    get:\n      parameters:\n        - {name: q, in: query, required: si, schema: {type: string}}\n      responses:\n        '200': {description: 1}\n");
    expect(messages(a)).toEqual(["7:42 Se esperaba verdadero o falso y hay texto", "9:30 Se esperaba texto y hay un entero"]);
  });

  it("points Swagger 2.0 typos at the misspelt key", () => {
    const a = analyzeDocument("swagger: '2.0'\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        200: {descripcion: ok}\n");
    expect(messages(a)).toEqual([
      "7:9 Falta la propiedad obligatoria «description»",
      "7:15 Propiedad no permitida aquí: «descripcion»; las extensiones propias empiezan por «x-»",
    ]);
  });

  it("merges the allowed values of alternatives", () => {
    const a = analyzeDocument("asyncapi: 3.0.0\ninfo: {title: E, version: '1'}\noperations:\n  enviar:\n    action: mandar\n    channel: {$ref: '#/channels/pedido'}\nchannels:\n  pedido: {address: p}\n");
    expect(messages(a)).toEqual(["5:13 Valor no permitido; usa uno de: «send», «receive»"]);
  });

  it("asks for one of paths, components or webhooks in 3.1", () => {
    expect(messages(analyzeDocument("openapi: 3.1.0\ninfo: {title: A, version: '1'}\n"))).toEqual(["1:1 Falta una de estas propiedades: «paths», «components» o «webhooks»"]);
  });

  it("checks local references, ignoring examples and extensions", () => {
    const source = `openapi: 3.1.0
info: {title: A, version: '1'}
paths: {}
components:
  schemas:
    A: {$ref: '#/components/schemas/B'}
    B: {type: string, example: {$ref: '#/nada'}}
    C: {$ref: 'otro.yaml#/components/schemas/D'}
    D: {$ref: 'nada'}
  x-notas: {$ref: '#/tampoco'}
`;
    expect(messages(analyzeDocument(source))).toEqual([]);
    expect(messages(analyzeDocument(source.replace("schemas/B'}", "schemas/Z'}")))).toEqual(["6:15 La referencia «#/components/schemas/Z» no existe"]);
    expect(messages(analyzeDocument(source.replace("'#/components/schemas/B'", "'#components'")))).toEqual(["6:15 Referencia mal escrita: «#components»"]);
  });

  it("stops at problems that prevent validation", () => {
    expect(messages(analyzeDocument("openapi: 4.0.0\ninfo: {title: A, version: '1'}\n"))).toEqual(["1:10 Versión de OpenAPI no reconocida: 4.0.0"]);
    expect(messages(analyzeDocument("- a\n"))).toEqual(["1:1 La raíz del documento debe ser un objeto"]);
    expect(analyzeDocument("a: [").diagnostics[0]!.source).toBe("sintaxis");
  });
});

describe("schemaFor", () => {
  it("uses the exact AsyncAPI schema, or the latest of the major with a note", () => {
    expect(schemaFor("asyncapi-2", "2.3.0")).toMatchObject({ key: "asyncapi-2.3.0", note: null });
    expect(schemaFor("asyncapi-3", "3.9.0")).toMatchObject({ key: "asyncapi-3.1.0", note: expect.stringContaining("3.9.0") });
    const a = analyzeDocument("asyncapi: 3.9.0\ninfo: {title: E, version: '1'}\n");
    expect(a.diagnostics).toEqual([expect.objectContaining({ severity: "info", code: "spec/schema-fallback" })]);
  });
});

describe("suggest", () => {
  it("proposes close names only", () => {
    expect(suggest("Pedid", ["Producto", "Pedido", "Cliente"])).toBe("Pedido");
    expect(suggest("ErrorRespuesta", ["ErrorRespuest", "Error"])).toBe("ErrorRespuest");
    expect(suggest("Zeta", ["Producto", "Pedido"])).toBeNull();
    expect(suggest("Z", ["A", "B"])).toBeNull();
  });
});
