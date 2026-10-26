import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FUNCTIONS, STARTER_GUIDE, analyzeDocument, builtinGuide, checkGuideText, loadGuide, memoryReader, type Analysis } from "@specix/core";

const guideMessages = (a: Analysis) => a.diagnostics.filter((d) => d.source === "guía").map((d) => `${d.range.start.line} ${d.severity} ${d.code} ${d.message}`);
const lines = (...l: string[]) => l.join("\n");

const doc = lines(
  "openapi: 3.1.0",
  "info: {title: Tienda, version: 1.0.0}",
  "paths:",
  "  /productos/:",
  "    get:",
  "      operationId: Obtener_Productos",
  "      responses: {'404': {description: no}}",
  "  /pedidos?estado=abierto:",
  "    post:",
  "      operationId: crearPedido",
  "      summary: Crea un pedido",
  "      tags: [pedidos]",
  "      responses: {'201': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Pedido'}}}}}",
  "components:",
  "  schemas:",
  "    Pedido: {type: object}",
  "    Olvidado: {type: object}",
);

describe("built-in base guide", () => {
  it("reports what an API is missing, in Spanish, at the right line", () => {
    const a = analyzeDocument(doc, { guide: builtinGuide() });
    expect(a.diagnostics.filter((d) => d.source !== "guía")).toEqual([]);
    expect(guideMessages(a)).toEqual([
      "2 warning guia/info-description Falta info.description, que explique qué ofrece la API",
      "2 info guia/info-contact Falta info.contact (a quién preguntar por la API)",
      "4 warning guia/path-trailing-slash La ruta «/productos/» termina en «/»",
      "5 warning guia/operation-summary La operación no tiene summary",
      "5 warning guia/operation-tags La operación no tiene etiquetas",
      "7 warning guia/operation-success-response No hay ninguna respuesta de éxito (2xx o 3xx)",
      "8 error guia/path-query-string La ruta «/pedidos?estado=abierto» lleva una consulta («?»); declárala en parameters",
      "17 warning guia/components-unused «Olvidado» no se usa en ninguna parte del documento",
      "1 warning guia/servers-defined No hay servidores definidos",
    ].sort((x, y) => Number(x.split(" ")[0]) - Number(y.split(" ")[0])));
    expect(a.guide).toMatchObject({ name: "specix:base", problems: [] });
  });

  it("only runs rules that apply to the specification", () => {
    const a = analyzeDocument("asyncapi: 3.0.0\ninfo: {title: E, version: '1', description: x, contact: {name: y}}\nchannels: {c: {address: c}}\noperations:\n  enviar: {action: send, channel: {$ref: '#/channels/c'}}\n", { guide: builtinGuide() });
    expect(guideMessages(a)).toEqual(["5 info guia/asyncapi-operation-summary La operación no tiene summary"]);
  });
});

describe("workspace guides", () => {
  it("extends the base, adds house rules and changes severities", () => {
    const guide = loadGuide({ name: "/ws/guias/empresa.yaml", text: STARTER_GUIDE });
    expect(guide.problems).toEqual([]);
    expect(guide.rules.find((r) => r.name === "info-contact")?.severity).toBe("warning");
    const a = analyzeDocument(doc, { guide });
    expect(guideMessages(a)).toContain("6 warning guia/operation-id-camelcase operationId debe ir en camelCase: «Obtener_Productos»");
    expect(guideMessages(a)).toContain("2 warning guia/info-contact Falta info.contact (a quién preguntar por la API)");
  });

  it("extends files relative to the guide and turns rules off", () => {
    const reader = memoryReader({ "/ws/guias/comun.yaml": "rules:\n  sin-x:\n    given: $.info\n    then: {field: x-equipo, function: truthy}\n    message: Falta x-equipo\n" }, "/ws");
    const guide = loadGuide({ name: "/ws/guias/empresa.yaml", text: "extends: [specix:base, ./comun.yaml]\nrules:\n  operation-tags: off\n  servers-defined: false\n" }, reader);
    expect(guide.problems).toEqual([]);
    const codes = analyzeDocument(doc, { guide }).diagnostics.map((d) => d.code);
    expect(codes).toContain("guia/sin-x");
    expect(codes).not.toContain("guia/operation-tags");
    expect(codes).not.toContain("guia/servers-defined");
  });

  it("maps Spectral's own rulesets to the base and explains what it cannot run", () => {
    const guide = loadGuide({ name: "g.yaml", text: "extends: spectral:oas\nrules:\n  rara:\n    given: $\n    then: {function: oasOpSuccessResponse}\n  nada: error\n" });
    expect(guide.rules.some((r) => r.name === "operation-summary")).toBe(true);
    expect(guide.problems.map((p) => p.message)).toEqual([
      "La regla «rara» usa la función «oasOpSuccessResponse», que Specix no tiene; se omite",
      "La regla «nada» cambia la severidad de una regla que no existe",
    ]);
    expect(loadGuide({ name: "a.yaml", text: "extends: [./a.yaml]" }, memoryReader({ "/x/a.yaml": "extends: [./a.yaml]" }, "/")).problems.length).toBeGreaterThan(0);
  });
});

describe("guide file checks", () => {
  it("points at unknown functions, severities and formats", () => {
    const text = lines("rules:", "  r1:", "    severity: grave", "    formats: [oas4]", "    given: $", "    then: {function: magia}");
    expect(checkGuideText(text).map((d) => `${d.range.start.line} ${d.code} ${d.message.split(":")[0]}`)).toEqual([
      "3 guide/invalid Severidad desconocida «grave»",
      "6 guide/unknown-function Función no admitida",
      "4 guide/invalid Formato desconocido «oas4»",
    ]);
    expect(checkGuideText(STARTER_GUIDE)).toEqual([]);
    expect(checkGuideText("rules: {r: {then: {function: truthy}}}")[0]!.message).toMatch(/^La guía no es válida aquí/);
  });
});

describe("functions", () => {
  const run = (name: string, value: unknown, options: Record<string, unknown> = {}) => FUNCTIONS[name]!(value, options, { document: {}, pointer: "" });
  it.each([
    ["camel", "obtenerProducto", true],
    ["camel", "ObtenerProducto", false],
    ["camel", "obtener_producto", false],
    ["pascal", "PedidoResumen", true],
    ["kebab", "lista-de-precios", true],
    ["kebab", "lista_de_precios", false],
    ["snake", "lista_de_precios", true],
    ["macro", "LISTA_DE_PRECIOS", true],
    ["cobol", "LISTA-DE-PRECIOS", true],
    ["flat", "pedidos", true],
  ])("casing %s %s", (type, value, ok) => {
    expect(run("casing", value, { type }).length === 0).toBe(ok);
  });

  it("casing with separators and digits", () => {
    expect(run("casing", "v2Pedidos", { type: "camel", disallowDigits: true })).toHaveLength(1);
    expect(run("casing", "/pedidos/{id}/lineas", { type: "kebab", separator: { char: "/", allowLeading: true } })).toHaveLength(1);
    expect(run("casing", "/pedidos/lineas-abiertas", { type: "kebab", separator: { char: "/", allowLeading: true } })).toHaveLength(0);
  });

  it("covers the rest of the functions", () => {
    expect(run("truthy", "")).toHaveLength(1);
    expect(run("falsy", [])).toHaveLength(0);
    expect(run("defined", undefined)).toHaveLength(1);
    expect(run("undefined", 1)).toHaveLength(1);
    expect(run("pattern", "abc", { match: "^a" })).toHaveLength(0);
    expect(run("pattern", "abc", { notMatch: "/B/i" })).toHaveLength(1);
    expect(run("enumeration", "xml", { values: ["json", "yaml"] })[0]!.message).toBe("«xml» no es uno de: json, yaml");
    expect(run("length", "hola", { max: 3 })[0]!.message).toBe("Mide 4; el máximo es 3");
    expect(run("alphabetical", ["b", "a"])).toHaveLength(1);
    expect(run("alphabetical", [{ name: "a" }, { name: "b" }], { keyedBy: "name" })).toHaveLength(0);
    expect(run("xor", { a: 1, b: 2 }, { properties: ["a", "b"] })).toHaveLength(1);
    expect(run("schema", { n: "x" }, { schema: { type: "object", properties: { n: { type: "number" } } } })[0]!.message).toBe("/n must be number");
    expect(run("successResponse", { "404": {}, "2XX": {} })).toHaveLength(0);
  });

  it("finds unused components through the whole document", () => {
    const document = parse("components:\n  schemas:\n    A: {type: object}\n    B: {properties: {a: {$ref: '#/components/schemas/A'}}}\n");
    expect(FUNCTIONS["unusedComponent"]!(document.components.schemas, {}, { document, pointer: "/components/schemas" }).map((r) => r.path)).toEqual([["B"]]);
  });
});
