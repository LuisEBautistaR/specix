import { relative, resolve } from "node:path";
import {
  analyzeDocument,
  applies,
  builtinGuide,
  bundle,
  checkGuideText,
  complete,
  definition,
  docModel,
  fsReader,
  hover,
  loadDocument,
  loadGuide,
  pathAt,
  type Analysis,
  type FileReader,
  type Guide,
} from "@specix/core";
import type { HostParams, HostResult } from "@shared/host-methods";
import type { Handlers } from "./rpc-server";

export interface HostDeps {
  exit(code: number): void;
}

/** The workspace guide, read on every analysis so edits to it apply at once (guides are small). */
function guideAt(path: string | null, reader: FileReader): Guide {
  if (path === null) return builtinGuide();
  const text = reader.read(path);
  if (text === null) {
    const base = builtinGuide();
    return { ...base, problems: [{ guide: path, message: "No se pudo leer la guía del espacio de trabajo; se aplica la guía base" }] };
  }
  return loadGuide({ name: path, text }, reader);
}

function ruleView(rule: Guide["rules"][number], analysis: Analysis, root: string | undefined) {
  const origin = root && rule.origin.startsWith(root) ? relative(root, rule.origin).split("\\").join("/") : rule.origin;
  return {
    name: rule.name,
    severity: rule.severity,
    description: rule.description,
    given: rule.given,
    functions: rule.then.map((t) => t.function),
    origin,
    applies: applies(rule, analysis.family),
  };
}

/** The language host reads documents for main; it holds no state between calls yet. */
export function createHandlers(deps: HostDeps): Handlers {
  const startedAt = performance.now();

  return {
    "system.ping": (params): HostResult<"system.ping"> => {
      const { sentAt } = params as HostParams<"system.ping">;
      return { sentAt, hostTime: Date.now(), pid: process.pid, uptimeMs: Math.round(performance.now() - startedAt) };
    },
    "system.info": (): HostResult<"system.info"> => ({
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    }),
    "lang.analyze": (params): HostResult<"lang.analyze"> => {
      const { text, context } = params as HostParams<"lang.analyze">;
      const started = performance.now();
      const done = (analysis: Analysis, guide: Guide | null): HostResult<"lang.analyze"> => ({
        ...analysis,
        guide: analysis.guide && guide ? { ...analysis.guide, problems: analysis.guide.problems.slice(0, 100), rules: guide.rules.slice(0, 500).map((r) => ruleView(r, analysis, context?.root)) } : null,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
      if (!context) {
        // No workspace: the built-in base guide, so the demo shows what governance looks like.
        const guide = builtinGuide();
        return done(analyzeDocument(text, { guide }), guide);
      }
      const reader = fsReader(context.root);
      if (context.role === "guide") {
        // A guide file is checked as a guide, not as an API definition.
        const doc = loadDocument(text);
        const empty: Analysis = { format: doc.format, family: null, specVersion: null, title: null, apiVersion: null, operations: 0, schema: null, diagnostics: checkGuideText(text), outline: [], guide: null };
        return done(empty, null);
      }
      const guide = context.role === "api" && !context.fragment ? guideAt(context.guide, reader) : null;
      return done(analyzeDocument(text, { file: context.file, reader, fragment: context.fragment, ...(guide ? { guide } : {}) }), guide);
    },
    "lang.docs": (params): HostResult<"lang.docs"> => {
      const { text, context } = params as HostParams<"lang.docs">;
      if (context && !context.fragment) {
        // The open file comes from the editor (it may be unsaved); the files it references from disk.
        const disk = fsReader(context.root);
        const reader: FileReader = { read: (p) => (resolve(p) === resolve(context.file) ? text : disk.read(p)), whyNot: (p) => disk.whyNot(p) };
        const result = bundle(context.file, reader);
        if (result.document !== null) return docModel(result.document) as unknown as HostResult<"lang.docs">;
      }
      const doc = loadDocument(text);
      return doc.value === undefined ? null : (docModel(doc.value) as unknown as HostResult<"lang.docs">);
    },
    "lang.complete": (params): HostResult<"lang.complete"> => {
      const { text, line, column } = params as HostParams<"lang.complete">;
      return complete(text, { line, column });
    },
    "lang.hover": (params): HostResult<"lang.hover"> => {
      const { text, line, column } = params as HostParams<"lang.hover">;
      return hover(text, { line, column });
    },
    "lang.definition": (params): HostResult<"lang.definition"> => {
      const { text, line, column } = params as HostParams<"lang.definition">;
      return definition(text, { line, column });
    },
    "lang.path": (params): HostResult<"lang.path"> => {
      const { text, line, column } = params as HostParams<"lang.path">;
      return pathAt(text, { line, column });
    },
    "diagnostics.crash": (params): HostResult<"diagnostics.crash"> => {
      const { exitCode } = params as HostParams<"diagnostics.crash">;
      // Exit after the result has been posted back.
      setTimeout(() => deps.exit(exitCode), 50);
      return { scheduled: true };
    },
  };
}
