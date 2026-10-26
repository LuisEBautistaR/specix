import type { Outcome } from "../shared/rpc";
import type { AppInfo, CompletionResult, DocModel, DocumentAnalysis, HoverResult, LangStatus, OpenedFile, PingResult, TextRange, WorkspaceView } from "../shared/ipc";

export type ApiKind = "api" | "domain";

/** A document and a 1-based cursor position. */
export interface Cursor {
  text: string;
  line: number;
  column: number;
}

/** What the preload exposes to the renderer as window.specix. Nothing else crosses the bridge. */
export interface SpecixApi {
  lang: {
    status(): Promise<LangStatus | null>;
    /** Structural check of a document (syntax, official schema, local references), run by the language host. */
    /** With the workspace-relative path of the file, references to other files are checked too. */
    analyze(text: string, file?: string): Promise<Outcome<DocumentAnalysis>>;
    /** Documentation model of the text (and, with its path, of the files it references). */
    docs(text: string, file?: string): Promise<Outcome<DocModel | null>>;
    /** Keys, values or $ref targets that fit at the cursor. */
    complete(cursor: Cursor): Promise<Outcome<CompletionResult | null>>;
    /** Spanish explanation of the key under the cursor, or the target of a $ref. */
    hover(cursor: Cursor): Promise<Outcome<HoverResult | null>>;
    /** Where the local $ref under the cursor points. */
    definition(cursor: Cursor): Promise<Outcome<TextRange | null>>;
    /** Path of the node under the cursor, for the breadcrumb. */
    path(cursor: Cursor): Promise<Outcome<string[]>>;
    ping(): Promise<Outcome<PingResult>>;
    /** Test builds only (SPECIX_TEST=1); answers UNKNOWN_METHOD otherwise. */
    crashHost(): Promise<Outcome<{ scheduled: true }>>;
    onStatus(listener: (status: LangStatus) => void): () => void;
  };
  app: {
    info(): Promise<AppInfo | null>;
  };
  workspace: {
    get(): Promise<WorkspaceView | null>;
    /** Asks for a folder and opens it; null value when the user cancels. */
    openDialog(): Promise<Outcome<WorkspaceView | null>>;
    /** Asks for an empty folder and creates a workspace in it. */
    createDialog(name?: string): Promise<Outcome<WorkspaceView | null>>;
    read(path: string): Promise<Outcome<OpenedFile>>;
    write(path: string, text: string): Promise<Outcome<{ savedAt: number }>>;
    createApi(request: { kind: ApiKind; name: string; template?: string; title?: string }): Promise<Outcome<WorkspaceView>>;
    createVersion(request: { kind: ApiKind; name: string; from: string; to: string }): Promise<Outcome<WorkspaceView>>;
    publish(request: { kind: ApiKind; name: string; version: string }): Promise<Outcome<WorkspaceView>>;
    setDefault(request: { kind: ApiKind; name: string; version: string }): Promise<Outcome<WorkspaceView>>;
    onChanged(listener: (view: WorkspaceView | null) => void): () => void;
  };
  docs: {
    /** Asks for a folder and writes the static site there (the whole workspace, or the given text alone). */
    export(request: { text?: string; brand?: string; color?: string; publishedOnly?: boolean }): Promise<Outcome<{ dir: string; pages: number; problems: string[] } | null>>;
    /** Opens the index.html of the last export in the default browser. */
    openExport(): Promise<Outcome<true>>;
  };
}

declare global {
  interface Window {
    specix: SpecixApi;
  }
}
