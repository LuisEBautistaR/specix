import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEMO_SPEC,
  createApi,
  createVersion,
  createWorkspace,
  docModel,
  exportWorkspaceDocs,
  markdownToHtml,
  publishVersion,
  renderDocsPage,
  safeColor,
  sampleOf,
} from "@specix/core";

const tienda = parse(`openapi: 3.1.0
info:
  title: Tienda
  version: 1.1.0
  description: Catálogo y **pedidos**.
servers: [{url: 'https://api.tienda-demo.test/v1', description: Producción}]
tags: [{name: pedidos, description: Ciclo de vida de un pedido}]
security: [{bearerAuth: []}]
paths:
  /pedidos/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: string}}
    post:
      tags: [pedidos]
      summary: Paga un pedido
      operationId: pagarPedido
      requestBody:
        required: true
        content:
          application/json:
            schema: {$ref: '#/components/schemas/Pago'}
            examples: {tarjeta: {value: {importe: 10}}}
      responses:
        '200': {description: Pagado, headers: {Location: {schema: {type: string}}}}
        '409': {$ref: '#/components/responses/Error'}
  /salud:
    get: {responses: {'200': {description: ok}}, deprecated: true}
webhooks:
  pedidoEnviado:
    post: {responses: {'200': {description: ok}}}
components:
  securitySchemes:
    bearerAuth: {type: http, scheme: bearer}
  responses:
    Error:
      description: Conflicto
      content: {application/json: {schema: {$ref: '#/components/schemas/Error'}}}
  schemas:
    Pago:
      type: object
      required: [importe]
      properties:
        importe: {type: number, minimum: 1}
        moneda: {type: string, enum: [MXN, USD], default: MXN}
        lineas: {type: array, items: {$ref: '#/components/schemas/Linea'}, minItems: 1}
    Linea: {type: object, properties: {sku: {type: string}}}
    Error: {type: object, properties: {codigo: {type: string}}}
`);

describe("docModel", () => {
  const model = docModel(tienda);

  it("groups operations by tag and keeps the rest apart", () => {
    expect(model).toMatchObject({ family: "openapi-3.1", title: "Tienda", version: "1.1.0", operationCount: 3 });
    expect(model.groups.map((g) => [g.name, g.operations.map((o) => `${o.method} ${o.path}`)])).toEqual([
      ["pedidos", ["POST /pedidos/{id}"]],
      ["Sin etiqueta", ["GET /salud"]],
    ]);
    expect(model.groups[1]!.operations[0]!.deprecated).toBe(true);
    expect(model.webhooks.map((w) => w.path)).toEqual(["pedidoEnviado"]);
    expect(model.servers).toEqual([{ url: "https://api.tienda-demo.test/v1", description: "Producción" }]);
    expect(model.security).toEqual([{ name: "bearerAuth", type: "http · bearer", description: null }]);
  });

  it("resolves parameters, bodies and responses", () => {
    const op = model.groups[0]!.operations[0]!;
    expect(op).toMatchObject({ anchor: "post-pedidos-id", operationId: "pagarPedido", security: ["bearerAuth"] });
    expect(op.parameters).toEqual([expect.objectContaining({ name: "id", in: "path", required: true, schema: expect.objectContaining({ type: "string" }) })]);
    const body = op.requestBody!.contents[0]!;
    expect(body.schema).toMatchObject({ ref: "Pago", type: "object" });
    expect(body.schema!.properties.map((p) => `${p.name}${p.required ? "*" : ""}:${p.schema.type}`)).toEqual(["importe*:number", "moneda:string", "lineas:array<Linea>"]);
    expect(body.schema!.properties[0]!.schema.constraints).toEqual(["mínimo 1"]);
    expect(body.schema!.properties[1]!.schema).toMatchObject({ enum: ["MXN", "USD"], constraints: ['por defecto "MXN"'] });
    expect(body.example).toBe('{\n  "importe": 10\n}');
    expect(op.responses.map((r) => `${r.code} ${r.description}`)).toEqual(["200 Pagado", "409 Conflicto"]);
    expect(op.responses[0]!.headers).toEqual(["Location"]);
    expect(op.responses[1]!.contents[0]!.schema).toMatchObject({ ref: "Error" });
  });

  it("lists schemas and documents Swagger 2.0 and AsyncAPI", () => {
    expect(model.schemas.map((s) => s.name)).toEqual(["Pago", "Linea", "Error"]);
    const swagger = docModel(parse("swagger: '2.0'\ninfo: {title: L, version: '5'}\nhost: erp.test\nbasePath: /v5\npaths:\n  /a:\n    post:\n      parameters:\n        - {name: q, in: query, type: integer}\n        - {name: cuerpo, in: body, schema: {$ref: '#/definitions/A'}}\n      responses: {'201': {description: ok, schema: {type: string}}}\ndefinitions:\n  A: {type: object}\n"));
    expect(swagger.servers[0]!.url).toBe("https://erp.test/v5");
    const op = swagger.groups[0]!.operations[0]!;
    expect(op.parameters.map((p) => `${p.name}:${p.schema?.type}`)).toEqual(["q:integer"]);
    expect(op.requestBody!.contents[0]!.schema!.ref).toBe("A");
    const async = docModel(parse("asyncapi: 3.0.0\ninfo: {title: E, version: '1'}\nchannels:\n  pedido: {address: tienda.pedido, messages: {creado: {payload: {type: object}}}}\noperations:\n  enviar: {action: send, channel: {$ref: '#/channels/pedido'}}\n"));
    expect(async.channels).toEqual([expect.objectContaining({ name: "pedido", address: "tienda.pedido", operations: [{ name: "enviar", action: "send", summary: null }] })]);
    expect(async.operationCount).toBe(1);
  });
});

describe("samples", () => {
  it("fills bodies and responses with data when the document has no example", () => {
    const op = docModel(tienda).groups[0]!.operations[0]!;
    expect(op.requestBody!.contents[0]!.example).not.toBeNull();
    expect(JSON.parse(op.requestBody!.contents[0]!.sample!)).toEqual({ importe: 1, moneda: "MXN", lineas: [{ sku: "SKU-1001" }] });
    expect(JSON.parse(op.responses[1]!.contents[0]!.sample!)).toEqual({ codigo: "a1b2c3" });
    expect(docModel(tienda).schemas.map((s) => s.sample !== null)).toEqual([true, true, true]);
  });

  it("uses formats, examples and constraints, and stops at cycles", () => {
    const doc = {
      components: {
        schemas: {
          Nodo: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", readOnly: true },
              creado: { type: "string", format: "date-time" },
              total: { type: "integer", minimum: 5, multipleOf: 10 },
              tipo: { type: "string", enum: ["a", "b"] },
              alias: { type: "string", example: "raíz" },
              hijos: { type: "array", items: { $ref: "#/components/schemas/Nodo" } },
              padre: { anyOf: [{ type: "null" }, { $ref: "#/components/schemas/Nodo" }] },
              extra: { type: "object", additionalProperties: { type: "boolean" } },
            },
          },
        },
      },
    };
    const schema = { $ref: "#/components/schemas/Nodo" };
    expect(sampleOf(doc, schema)).toEqual({ id: "0b6f2c1e-8a4d-4c3b-9e2f-5d7a1b3c4e6f", creado: "2026-03-14T10:30:00Z", total: 10, tipo: "a", alias: "raíz", hijos: [], extra: { clave: true } });
    expect(sampleOf(doc, schema, "request")).not.toHaveProperty("id");
    expect(sampleOf(doc, { allOf: [{ $ref: "#/components/schemas/Nodo" }, { properties: { nuevo: { type: "boolean" } } }] })).toMatchObject({ alias: "raíz", nuevo: true });
  });
});

describe("HTML", () => {
  it("escapes everything and only lets safe Markdown through", () => {
    const html = markdownToHtml("Hola **mundo** <script>alert(1)</script>\n\n- uno\n- [dos](https://ejemplo.test)\n- [mal](javascript:alert(1))\n\n```\n<b>\n```");
    expect(html).toContain("<strong>mundo</strong> &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<li><a href="https://ejemplo.test" rel="noopener noreferrer">dos</a></li>');
    expect(html).toContain("<li>[mal](javascript:alert(1))</li>");
    expect(html).toContain("<pre><code>&lt;b&gt;</code></pre>");
  });

  it("renders a self-contained page with a strict CSP and the brand colour", () => {
    const page = renderDocsPage(docModel({ ...tienda, info: { ...tienda.info, title: "Tienda <b>" } }), { brand: { name: "Mi empresa", color: "#123456", logo: null } });
    expect(page).toContain("default-src 'none'");
    expect(page).not.toMatch(/<script|src="http/);
    expect(page).toContain("--brand: #123456");
    expect(page).toContain("Tienda &lt;b&gt;");
    expect(page).toContain('id="post-pedidos-id"');
    expect(page).toContain("<code>MXN</code> · <code>USD</code>");
    expect(page).toContain("generado del esquema");
    expect(page).toContain("&quot;importe&quot;: 10");
    expect(safeColor("red;}body{display:none")).toBe("#5c6b54");
  });
});

describe("exportWorkspaceDocs", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "specix-docs-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes an index, one page per version and the default version at the API root", async () => {
    let ws = await createWorkspace(join(dir, "ws"), "Tienda demo");
    ws = await createApi(ws, "tienda", { title: "Tienda" });
    ws = await publishVersion(ws, "api", "tienda", "1.0.0");
    ws = await createVersion(ws, "api", "tienda", "1.0.0", "1.1.0");
    await writeFile(join(ws.root, "apis/tienda/1.1.0/openapi.yaml"), DEMO_SPEC.replace("version: 1.0.0", "version: 1.1.0"));

    const result = await exportWorkspaceDocs(ws, join(dir, "sitio"), { brand: { name: "Mi empresa", color: "#334455", logo: null } });
    expect(result.problems).toEqual([]);
    expect(result.pages).toEqual(["index.html", "tienda/1.0.0/index.html", "tienda/index.html", "tienda/1.1.0/index.html"]);
    const index = await readFile(join(dir, "sitio/index.html"), "utf8");
    expect(index).toContain('href="tienda/1.1.0/index.html"');
    expect(index).toContain("(por defecto)");
    const latest = await readFile(join(dir, "sitio/tienda/1.1.0/index.html"), "utf8");
    expect(latest).toContain("Crea un pedido");

    const published = await exportWorkspaceDocs(ws, join(dir, "solo-publicadas"), { includeDrafts: false });
    expect(published.pages).toEqual(["index.html", "tienda/1.0.0/index.html", "tienda/index.html"]);
  });
});
