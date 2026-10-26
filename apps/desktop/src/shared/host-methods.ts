/**
 * Every method the language host exposes to main, with its params and result contracts.
 * Only main calls these: the renderer talks to main through the named channels
 * in ./ipc.ts and never reaches the host directly.
 */
import { z } from "zod";

/** Documents bigger than this are refused before they reach the host. */
export const MAX_DOCUMENT_CHARS = 5 * 1024 * 1024;

const positionSchema = z.object({ line: z.number().int().min(1), column: z.number().int().min(1) });

export const diagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "info", "hint"]),
  code: z.string(),
  message: z.string(),
  source: z.enum(["sintaxis", "estructura", "referencias", "guía"]),
  pointer: z.string(),
  range: z.object({ start: positionSchema, end: positionSchema }),
});

export const outlineItemSchema = z.object({
  kind: z.enum(["operation", "webhook", "channel", "component"]),
  method: z.string().nullable(),
  label: z.string(),
  group: z.string(),
  pointer: z.string(),
  line: z.number().int().min(1),
});

export const rangeSchema = z.object({ start: positionSchema, end: positionSchema });

/** A document plus a cursor: what every editor feature asks about. */
export const cursorParams = z.object({
  text: z.string().max(MAX_DOCUMENT_CHARS),
  line: z.number().int().min(1).max(10_000_000),
  column: z.number().int().min(1).max(100_000),
});

export const analysisSchema = z.object({
  format: z.enum(["yaml", "json"]),
  family: z.enum(["swagger-2.0", "openapi-3.0", "openapi-3.1", "openapi-3.2", "asyncapi-2", "asyncapi-3"]).nullable(),
  specVersion: z.string().nullable(),
  title: z.string().nullable(),
  apiVersion: z.string().nullable(),
  operations: z.number().int().min(0),
  schema: z.string().nullable(),
  diagnostics: z.array(diagnosticSchema).max(500),
  outline: z.array(outlineItemSchema).max(1000),
  /** The style guide applied (APIs only), with its rules for the governance view. */
  guide: z
    .object({
      name: z.string(),
      rulesRun: z.number().int().min(0),
      problems: z.array(z.string()).max(100),
      rules: z
        .array(
          z.object({
            name: z.string(),
            severity: z.enum(["error", "warning", "info", "hint", "off"]),
            description: z.string().nullable(),
            given: z.array(z.string()),
            functions: z.array(z.string()),
            origin: z.string(),
            applies: z.boolean(),
          }),
        )
        .max(500),
    })
    .nullable(),
});

/**
 * Where a text lives: the workspace root, its absolute path, whether it is a
 * fragment (not a version's entry), what it is and the guide to apply
 * (absolute path, or null for the built-in base).
 */
export const contextSchema = z.object({
  root: z.string().min(1),
  file: z.string().min(1),
  fragment: z.boolean(),
  role: z.enum(["api", "domain", "guide"]),
  guide: z.string().min(1).nullable(),
});

export const hostMethods = {
  "system.ping": {
    params: z.object({ sentAt: z.number() }),
    result: z.object({
      sentAt: z.number(),
      hostTime: z.number(),
      pid: z.number().int(),
      uptimeMs: z.number(),
    }),
    testOnly: false,
  },
  "system.info": {
    params: z.object({}),
    result: z.object({
      node: z.string(),
      v8: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    testOnly: false,
  },
  /** Full structural check: syntax, specification, official schema and local references. */
  "lang.analyze": {
    params: z.object({
      text: z.string().max(MAX_DOCUMENT_CHARS),
      /** Where the text lives in the workspace, so references to other files can be followed. */
      context: contextSchema.optional(),
    }),
    result: analysisSchema.extend({ durationMs: z.number().min(0) }),
    testOnly: false,
  },
  /** Documentation model of the document (with the files it references, read from disk). */
  "lang.docs": {
    params: z.object({
      text: z.string().max(MAX_DOCUMENT_CHARS),
      context: contextSchema.optional(),
    }),
    // The model is rendered as text by React; its outer shape is checked here.
    result: z
      .object({
        title: z.string(),
        version: z.string().nullable(),
        groups: z.array(z.unknown()).max(5000),
        webhooks: z.array(z.unknown()).max(5000),
        channels: z.array(z.unknown()).max(5000),
        schemas: z.array(z.unknown()).max(5000),
      })
      .passthrough()
      .nullable(),
    testOnly: false,
  },
  "lang.complete": {
    params: cursorParams,
    result: z
      .object({
        from: positionSchema,
        to: positionSchema,
        items: z
          .array(
            z.object({
              label: z.string(),
              insert: z.string(),
              kind: z.enum(["property", "value", "reference"]),
              detail: z.string().nullable(),
              info: z.string().nullable(),
            }),
          )
          .max(2000),
      })
      .nullable(),
    testOnly: false,
  },
  "lang.hover": {
    params: cursorParams,
    result: z.object({ range: rangeSchema, title: z.string(), text: z.string().nullable(), type: z.string().nullable() }).nullable(),
    testOnly: false,
  },
  "lang.definition": {
    params: cursorParams,
    result: rangeSchema.nullable(),
    testOnly: false,
  },
  "lang.path": {
    params: cursorParams,
    result: z.array(z.string()).max(200),
    testOnly: false,
  },
  /** Kills the host on purpose so tests can check that main restarts it. */
  "diagnostics.crash": {
    params: z.object({ exitCode: z.number().int().min(1).max(255) }),
    result: z.object({ scheduled: z.literal(true) }),
    testOnly: true,
  },
} as const;

export type HostMethod = keyof typeof hostMethods;
export type HostParams<M extends HostMethod> = z.input<(typeof hostMethods)[M]["params"]>;
export type HostResult<M extends HostMethod> = z.output<(typeof hostMethods)[M]["result"]>;

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && Object.hasOwn(hostMethods, value);
}
