export { DEMO_SPEC } from "./demo.js";
export {
  FAMILY_LABELS,
  summarizeDocument,
  type DocumentProblem,
  type DocumentSummary,
  type SpecFamily,
} from "./detect.js";
export {
  complete,
  definition,
  familyFromText,
  hover,
  pathAt,
  yamlPathAt,
  type CompletionItem,
  type CompletionResult,
  type HoverResult,
} from "./language.js";
export { outlineOf, type OutlineItem } from "./outline.js";
export { SchemaNavigator, type KeyInfo } from "./schema-nav.js";
export {
  jsonErrorOffset,
  loadDocument,
  offsetOf,
  parsePointer,
  pointerOf,
  type Diagnostic,
  type DiagnosticSource,
  type LoadedDocument,
  type Position,
  type Range,
  type Severity,
} from "./source.js";
export { MAX_DIAGNOSTICS, analyzeDocument, reduceErrors, schemaDocumentFor, schemaFor, suggest, type Analysis } from "./validate.js";
export { KEY_DOCS } from "./vocabulary.js";
export { bundle, checkExternalRefs, fsReader, memoryReader, parseRef, type BundleResult, type FileReader, type ParsedRef } from "./refs.js";
export type { AnalyzeOptions } from "./validate.js";
export {
  API_FILE,
  APIS_DIR,
  DOMAINS_DIR,
  GUIDES_DIR,
  TEMPLATES_DIR,
  WORKSPACE_FILE,
  compareVersions,
  type ApiFile,
  type VersionEntry,
} from "./workspace/format.js";
export { lintWorkspace, workspaceGuide, type FileLint, type WorkspaceLint } from "./workspace/lint.js";
export { BASE_GUIDE, BUILTIN_GUIDES, STARTER_GUIDE } from "./govern/builtin.js";
export { applies, runGuide, type GuideRun } from "./govern/engine.js";
export { FUNCTIONS, type RuleFunction } from "./govern/functions.js";
export { FORMAT_NAMES, builtinGuide, checkGuideText, formatsOf, loadGuide, type Guide, type Rule, type RuleSeverity } from "./govern/guide.js";
export { BUILTIN_TEMPLATES, fillTemplate } from "./workspace/templates.js";
export {
  WorkspaceError,
  createApi,
  createVersion,
  createWorkspace,
  fingerprintOf,
  insideWorkspace,
  loadWorkspace,
  publishVersion,
  setDefaultVersion,
  versionOfFile,
  writeAtomic,
  type ApiInfo,
  type CreateApiOptions,
  type TemplateInfo,
  type VersionInfo,
  type Workspace,
  type WorkspaceProblem,
} from "./workspace/workspace.js";
export { DEFAULT_BRAND, renderDocsIndex, renderDocsPage, safeColor, type Brand, type IndexEntry, type VersionLink } from "./docs/html.js";
export { escapeHtml, markdownToHtml } from "./docs/markdown.js";
export { anchorOf, docModel, type DocChannel, type DocContent, type DocGroup, type DocModel, type DocOperation, type DocParameter, type DocProperty, type DocResponse, type DocSchema } from "./docs/model.js";
export { sampleJson, sampleOf, type SampleDirection } from "./docs/example.js";
export { exportWorkspaceDocs, modelOfFile, type ExportResult } from "./docs/export.js";
