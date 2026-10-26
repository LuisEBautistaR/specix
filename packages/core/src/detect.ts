/**
 * First look at an API definition: does it parse, and which specification and
 * version does it claim to follow. validate.ts builds the full check on top.
 */
import { loadDocument } from "./source.js";

export type SpecFamily = "swagger-2.0" | "openapi-3.0" | "openapi-3.1" | "openapi-3.2" | "asyncapi-2" | "asyncapi-3";

/** Lines and columns start at 1, as editors show them. */
export interface DocumentProblem {
  message: string;
  line: number;
  column: number;
}

export interface DocumentSummary {
  format: "yaml" | "json";
  family: SpecFamily | null;
  /** The specification version as written in the document, e.g. "3.1.0". */
  specVersion: string | null;
  /** info.title and info.version of the API itself. */
  title: string | null;
  apiVersion: string | null;
  /** HTTP operations for OpenAPI, operations for AsyncAPI. */
  operations: number;
  problems: DocumentProblem[];
}

export const FAMILY_LABELS: Record<SpecFamily, string> = {
  "swagger-2.0": "Swagger 2.0",
  "openapi-3.0": "OpenAPI 3.0",
  "openapi-3.1": "OpenAPI 3.1",
  "openapi-3.2": "OpenAPI 3.2",
  "asyncapi-2": "AsyncAPI 2",
  "asyncapi-3": "AsyncAPI 3",
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]);

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" || typeof value === "number" ? String(value) : null);

export interface FamilyInfo {
  family: SpecFamily | null;
  specVersion: string | null;
  /** Why the family could not be recognised; null when it was. */
  problem: { code: string; message: string; pointer: string } | null;
}

export function familyOf(root: Json): FamilyInfo {
  const swagger = text(root["swagger"]);
  if (swagger !== null) {
    return swagger === "2.0"
      ? { family: "swagger-2.0", specVersion: swagger, problem: null }
      : { family: null, specVersion: swagger, problem: { code: "spec/unknown-version", message: `Versión de Swagger no reconocida: ${swagger}`, pointer: "/swagger" } };
  }
  const openapi = text(root["openapi"]);
  if (openapi !== null) {
    const minor = /^3\.([0-2])\.\d+(-.+)?$/.exec(openapi)?.[1];
    return minor !== undefined
      ? { family: `openapi-3.${minor}` as SpecFamily, specVersion: openapi, problem: null }
      : { family: null, specVersion: openapi, problem: { code: "spec/unknown-version", message: `Versión de OpenAPI no reconocida: ${openapi}`, pointer: "/openapi" } };
  }
  const asyncapi = text(root["asyncapi"]);
  if (asyncapi !== null) {
    const major = /^([23])\.\d+\.\d+(-.+)?$/.exec(asyncapi)?.[1];
    return major !== undefined
      ? { family: `asyncapi-${major}` as SpecFamily, specVersion: asyncapi, problem: null }
      : { family: null, specVersion: asyncapi, problem: { code: "spec/unknown-version", message: `Versión de AsyncAPI no reconocida: ${asyncapi}`, pointer: "/asyncapi" } };
  }
  return {
    family: null,
    specVersion: null,
    problem: { code: "spec/not-an-api", message: "No es una definición de API: falta «openapi», «swagger» o «asyncapi» en la raíz", pointer: "" },
  };
}

export function countOperations(root: Json, family: SpecFamily | null): number {
  if (family === null) return 0;
  if (family === "asyncapi-3") return isObject(root["operations"]) ? Object.keys(root["operations"]).length : 0;
  if (family === "asyncapi-2") {
    if (!isObject(root["channels"])) return 0;
    return Object.values(root["channels"]).reduce<number>(
      (n, channel) => n + (isObject(channel) ? ["publish", "subscribe"].filter((k) => isObject(channel[k])).length : 0),
      0,
    );
  }
  // Webhooks (3.1+) are operations the API calls on its clients: they count too.
  const items = [root["paths"], family === "openapi-3.1" || family === "openapi-3.2" ? root["webhooks"] : undefined]
    .filter(isObject)
    .flatMap((group) => Object.values(group));
  return items.reduce<number>((n, item) => n + (isObject(item) ? Object.keys(item).filter((k) => HTTP_METHODS.has(k)).length : 0), 0);
}

export function describeRoot(root: Json): Pick<DocumentSummary, "family" | "specVersion" | "title" | "apiVersion" | "operations"> & { problem: FamilyInfo["problem"] } {
  const { family, specVersion, problem } = familyOf(root);
  const info = isObject(root["info"]) ? root["info"] : {};
  return { family, specVersion, title: text(info["title"]), apiVersion: text(info["version"]), operations: countOperations(root, family), problem };
}

/** Cheap: parses and identifies the document without validating it. */
export function summarizeDocument(source: string): DocumentSummary {
  const doc = loadDocument(source);
  const empty: DocumentSummary = { format: doc.format, family: null, specVersion: null, title: null, apiVersion: null, operations: 0, problems: [] };
  const asProblem = (message: string, line: number, column: number): DocumentProblem => ({ message, line, column });

  if (doc.diagnostics.length) return { ...empty, problems: doc.diagnostics.map((d) => asProblem(d.message, d.range.start.line, d.range.start.column)) };
  if (!isObject(doc.value)) return { ...empty, problems: [asProblem("La raíz del documento debe ser un objeto", 1, 1)] };

  const { problem, ...described } = describeRoot(doc.value);
  const where = problem ? doc.locate(problem.pointer).start : null;
  return { format: doc.format, ...described, problems: problem && where ? [asProblem(problem.message, where.line, where.column)] : [] };
}
