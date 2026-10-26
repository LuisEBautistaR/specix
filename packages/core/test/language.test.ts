import { describe, expect, it } from "vitest";
import { analyzeDocument, complete, definition, familyFromText, hover, pathAt, yamlPathAt } from "@specix/core";

const lines = (...l: string[]) => l.join("\n");
const labels = (r: ReturnType<typeof complete>) => r?.items.map((i) => i.label) ?? null;

const typing = lines(
  "openapi: 3.1.0",
  "info:",
  "  title: Tienda",
  "  version: 1.0.0",
  "paths:",
  "  /pedidos:",
  "    post:",
  "      parameters:",
  "        - name: id",
  "          in: ",
  "      requestBody:",
  "        content:",
  "          application/json:",
  "            schema:",
  "              $ref: '#/components/schemas/Pe",
  "      responses:",
  "        '201':",
  "          description: creado",
  "        ",
  "components:",
  "  schemas:",
  "    Pedido: {type: object}",
  "    PedidoResumen: {type: object}",
  "    Cliente: {type: object}",
);

describe("yamlPathAt", () => {
  const doc = typing.split("\n");
  it("follows indentation, list items and quoted keys", () => {
    expect(yamlPathAt(doc, 9, 10)).toEqual(["paths", "/pedidos", "post", "parameters", "0"]);
    expect(yamlPathAt(doc, 18, 8)).toEqual(["paths", "/pedidos", "post", "responses"]);
    expect(yamlPathAt(doc, 17, 10)).toEqual(["paths", "/pedidos", "post", "responses", "201"]);
    expect(yamlPathAt(doc, 3, 2)).toEqual(["info"]);
    expect(yamlPathAt(doc, 4, 0)).toEqual([]);
  });

  it("handles lists written at the same indentation as their key", () => {
    const flat = ["paths:", "  /a:", "    get:", "      parameters:", "      - name: a", "        in: query", "      - name: b", "        "];
    expect(yamlPathAt(flat, 7, 8)).toEqual(["paths", "/a", "get", "parameters", "0"]);
  });
});

describe("complete", () => {
  it("offers the allowed values of a key from the official schema", () => {
    expect(labels(complete(typing, { line: 10, column: 15 }))).toEqual(["query", "header", "path", "cookie"]);
    const tight = complete(lines("asyncapi: 3.0.0", "operations:", "  enviar:", "    action:"), { line: 4, column: 12 });
    expect(tight?.items.map((i) => i.insert)).toEqual([" send", " receive"]);
  });

  it("offers local reference targets, quoted for YAML", () => {
    const r = complete(typing, { line: 15, column: 45 });
    expect(r?.from).toEqual({ line: 15, column: 22 });
    expect(r?.items.map((i) => i.insert)).toEqual(["#/components/schemas/Pedido", "#/components/schemas/PedidoResumen", "#/components/schemas/Cliente"]);
    expect(r?.items[0]).toMatchObject({ kind: "reference", detail: "components/schemas" });
    const bare = complete(lines("openapi: 3.1.0", "components:", "  schemas:", "    A: {type: object}", "    B:", "      $ref: "), { line: 6, column: 13 });
    expect(bare?.items.map((i) => i.insert)).toEqual(["'#/components/schemas/A'", "'#/components/schemas/B'"]);
  });

  it("offers the keys of the object, required first, without those already written", () => {
    const info = complete(lines("openapi: 3.1.0", "info:", "  title: A", "  "), { line: 4, column: 3 });
    expect(labels(info)?.[0]).toBe("version");
    expect(labels(info)).not.toContain("title");
    expect(info?.items[0]).toMatchObject({ insert: "version: ", detail: "texto · obligatoria" });
    expect(info?.items.find((i) => i.label === "contact")?.info).toMatch(/contacto/);

    const operation = complete(lines("openapi: 3.1.0", "paths:", "  /a:", "    get:", "      sum"), { line: 5, column: 10 });
    expect(operation?.from).toEqual({ line: 5, column: 7 });
    expect(labels(operation)).toEqual(expect.arrayContaining(["summary", "operationId", "parameters", "responses"]));
  });

  it("works for Swagger 2.0 and AsyncAPI", () => {
    expect(labels(complete(lines("swagger: '2.0'", "paths:", "  /a:", "    get:", "      parameters:", "      - name: q", "        in: "), { line: 7, column: 13 }))).toEqual(
      expect.arrayContaining(["query", "path", "header", "formData", "body"]),
    );
    expect(labels(complete(lines("asyncapi: 2.6.0", "  "), { line: 2, column: 1 }))).toEqual(expect.arrayContaining(["info", "channels", "components"]));
  });

  it("stays quiet where it has nothing to offer", () => {
    expect(complete("nombre: tienda\n", { line: 1, column: 9 })).toBeNull();
    expect(complete(lines("openapi: 3.1.0", "info:", "  title: A"), { line: 3, column: 12 })).toBeNull();
  });
});

const valid = lines(
  "openapi: 3.1.0",
  "info: {title: Tienda, version: 1.0.0}",
  "paths:",
  "  /pedidos:",
  "    post:",
  "      operationId: crearPedido",
  "      tags: [pedidos]",
  "      requestBody:",
  "        content:",
  "          application/json:",
  "            schema: {$ref: '#/components/schemas/Pedido'}",
  "      responses:",
  "        '201': {description: creado}",
  "webhooks:",
  "  pedidoEnviado:",
  "    post:",
  "      responses: {'200': {description: ok}}",
  "components:",
  "  schemas:",
  "    Pedido: {type: object, properties: {id: {type: string}}}",
);

describe("hover, definition and path", () => {
  it("explains keys in Spanish with their type", () => {
    expect(hover(valid, { line: 6, column: 9 })).toMatchObject({ title: "operationId", type: "texto", text: expect.stringContaining("Identificador único") });
    expect(hover(valid, { line: 6, column: 22 })).toBeNull();
  });

  it("summarises the target of a $ref", () => {
    expect(hover(valid, { line: 11, column: 30 })).toMatchObject({ title: "#/components/schemas/Pedido", text: expect.stringContaining("Objeto con 2 claves") });
  });

  it("jumps from a $ref to the key it names", () => {
    expect(definition(valid, { line: 11, column: 30 })).toEqual({ start: { line: 20, column: 5 }, end: { line: 20, column: 11 } });
    expect(definition(valid, { line: 6, column: 9 })).toBeNull();
    expect(definition(valid.replace("schemas/Pedido'", "schemas/Nada'"), { line: 11, column: 30 })).toBeNull();
  });

  it("gives the path under the cursor, also while the YAML is broken", () => {
    expect(pathAt(valid, { line: 11, column: 30 })).toEqual(["paths", "/pedidos", "post", "requestBody", "content", "application/json", "schema", "$ref"]);
    expect(pathAt(typing, { line: 10, column: 13 })).toEqual(["paths", "/pedidos", "post", "parameters", "0", "in"]);
    // In the indentation, the line's own key counts.
    expect(pathAt(valid, { line: 6, column: 1 })).toEqual(["paths", "/pedidos", "post", "operationId"]);
  });

  it("detects the specification from the text alone", () => {
    expect(familyFromText(typing)).toEqual({ family: "openapi-3.1", specVersion: "3.1.0" });
    expect(familyFromText('{\n  "swagger": "2.0"')).toEqual({ family: "swagger-2.0", specVersion: "2.0" });
    expect(familyFromText("nombre: x")).toBeNull();
  });
});

describe("outline", () => {
  it("lists operations by tag, webhooks and components with their line", () => {
    expect(analyzeDocument(valid).outline).toEqual([
      { kind: "operation", method: "POST", label: "/pedidos", group: "pedidos", pointer: "/paths/~1pedidos/post", line: 5 },
      { kind: "webhook", method: "POST", label: "pedidoEnviado", group: "webhooks", pointer: "/webhooks/pedidoEnviado/post", line: 16 },
      { kind: "component", method: null, label: "Pedido", group: "schemas", pointer: "/components/schemas/Pedido", line: 20 },
    ]);
  });

  it("lists AsyncAPI channels and operations", () => {
    const outline = analyzeDocument(lines("asyncapi: 3.0.0", "info: {title: E, version: '1'}", "channels:", "  pedido: {address: p}", "operations:", "  enviar: {action: send, channel: {$ref: '#/channels/pedido'}}")).outline;
    expect(outline.map((o) => `${o.kind}:${o.method ?? ""}:${o.label}`)).toEqual(["channel::pedido", "operation:SEND:enviar"]);
  });
});
