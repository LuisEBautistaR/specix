/** Channels between the renderer (through the preload bridge) and main. */
export const IpcChannels = {
  langStatus: "specix:lang-status",
  langAnalyze: "specix:lang-analyze",
  langDocs: "specix:lang-docs",
  docsExport: "specix:docs-export",
  docsOpenExport: "specix:docs-open-export",
  langComplete: "specix:lang-complete",
  langHover: "specix:lang-hover",
  langDefinition: "specix:lang-definition",
  langPath: "specix:lang-path",
  langPing: "specix:lang-ping",
  langCrashHost: "specix:lang-crash-host",
  langStatusChanged: "specix:lang-status-changed",
  appInfo: "specix:app-info",
  wsGet: "specix:ws-get",
  wsOpenDialog: "specix:ws-open-dialog",
  wsCreateDialog: "specix:ws-create-dialog",
  wsRead: "specix:ws-read",
  wsWrite: "specix:ws-write",
  wsCreateApi: "specix:ws-create-api",
  wsCreateVersion: "specix:ws-create-version",
  wsPublish: "specix:ws-publish",
  wsSetDefault: "specix:ws-set-default",
  wsChanged: "specix:ws-changed",
} as const;

export type LangState = "starting" | "ready" | "restarting" | "failed" | "stopped";

/** State of the language host, the utilityProcess that reads and checks documents. */
export interface LangStatus {
  state: LangState;
  /** Process id of the host while it exists. */
  pid: number | null;
  /** Times main restarted the host after a crash. */
  restarts: number;
  lastExit: { code: number; at: number } | null;
}

export type SpecFamily = "swagger-2.0" | "openapi-3.0" | "openapi-3.1" | "openapi-3.2" | "asyncapi-2" | "asyncapi-3";

export type Severity = "error" | "warning" | "info" | "hint";

/** Lines and columns start at 1. */
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  source: "sintaxis" | "estructura" | "referencias" | "guía";
  pointer: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export interface Position {
  line: number;
  column: number;
}

export interface TextRange {
  start: Position;
  end: Position;
}

export interface OutlineItem {
  kind: "operation" | "webhook" | "channel" | "component";
  method: string | null;
  label: string;
  group: string;
  pointer: string;
  line: number;
}

export interface CompletionResult {
  from: Position;
  to: Position;
  items: Array<{ label: string; insert: string; kind: "property" | "value" | "reference"; detail: string | null; info: string | null }>;
}

export interface HoverResult {
  range: TextRange;
  title: string;
  text: string | null;
  type: string | null;
}

export interface GuideRuleView {
  name: string;
  severity: Severity | "off";
  description: string | null;
  given: string[];
  functions: string[];
  /** Guide file (relative to the workspace) or built-in name the rule comes from. */
  origin: string;
  /** Whether the rule runs on this kind of specification. */
  applies: boolean;
}

export interface GuideSummary {
  name: string;
  rulesRun: number;
  problems: string[];
  rules: GuideRuleView[];
}

export interface DocumentAnalysis {
  format: "yaml" | "json";
  family: SpecFamily | null;
  specVersion: string | null;
  title: string | null;
  apiVersion: string | null;
  operations: number;
  /** Official schema applied, e.g. "OpenAPI 3.1 (2026-08-03)". */
  schema: string | null;
  diagnostics: Diagnostic[];
  outline: OutlineItem[];
  /** Style guide applied (APIs only); null for domains, fragments and guide files. */
  guide: GuideSummary | null;
  /** Time the host spent on the document. */
  durationMs: number;
}

export interface VersionView {
  version: string;
  state: "draft" | "published";
  /** Paths are relative to the workspace root, with forward slashes. */
  dir: string;
  entry: string;
  files: string[];
  /** Published, but changed on disk afterwards. */
  modified: boolean;
  isDefault: boolean;
}

export interface ApiView {
  name: string;
  dir: string;
  defaultVersion: string | null;
  versions: VersionView[];
}

export interface WorkspaceView {
  root: string;
  name: string;
  apis: ApiView[];
  domains: ApiView[];
  templates: Array<{ name: string; file: string }>;
  problems: Array<{ file: string; message: string }>;
  /** Style guide file (relative), or null for the built-in base. */
  guide: string | null;
  /** Every guide file under guias/. */
  guides: string[];
}

/** Documentation model, as built by the core (see packages/core/src/docs/model.ts). */
export interface DocSchema {
  type: string;
  ref: string | null;
  description: string | null;
  constraints: string[];
  enum: string[];
  properties: Array<{ name: string; required: boolean; schema: DocSchema }>;
  items: DocSchema | null;
  variants: { mode: "oneOf" | "anyOf" | "allOf"; options: DocSchema[] } | null;
}
export interface DocContent {
  mediaType: string;
  schema: DocSchema | null;
  example: string | null;
}
export interface DocOperation {
  anchor: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  operationId: string | null;
  deprecated: boolean;
  parameters: Array<{ name: string; in: string; required: boolean; deprecated: boolean; description: string | null; schema: DocSchema | null }>;
  requestBody: { required: boolean; description: string | null; contents: DocContent[] } | null;
  responses: Array<{ code: string; description: string; contents: DocContent[]; headers: string[] }>;
  security: string[];
}
export interface DocModel {
  family: SpecFamily | null;
  title: string;
  version: string | null;
  description: string | null;
  servers: Array<{ url: string; description: string | null }>;
  groups: Array<{ name: string; description: string | null; operations: DocOperation[] }>;
  webhooks: DocOperation[];
  channels: Array<{
    anchor: string;
    name: string;
    address: string | null;
    description: string | null;
    operations: Array<{ name: string; action: string; summary: string | null }>;
    messages: Array<{ name: string; summary: string | null; payload: DocSchema | null }>;
  }>;
  schemas: Array<{ name: string; anchor: string; schema: DocSchema }>;
  security: Array<{ name: string; type: string; description: string | null }>;
  operationCount: number;
}

export interface OpenedFile {
  path: string;
  text: string;
  /** Files of published versions are read-only. */
  readOnly: boolean;
  api: { kind: "api" | "domain"; name: string; version: string; state: "draft" | "published"; isDefault: boolean; entry: boolean } | null;
}

export interface PingResult {
  /** Round trip renderer → main → host → main. */
  roundTripMs: number;
  pid: number;
  uptimeMs: number;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  packaged: boolean;
}
