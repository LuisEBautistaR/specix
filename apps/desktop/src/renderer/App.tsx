import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_SPEC } from "@specix/core/demo";
import type { AppInfo, Diagnostic, DocModel, DocumentAnalysis, LangState, LangStatus, OpenedFile, OutlineItem, PingResult, Position, Severity, SpecFamily, WorkspaceView } from "@shared/ipc";
import type { RpcError } from "@shared/rpc";
import { Icon, type IconName } from "./Icon";
import { SpecEditor, type EditorServices, type SpecEditorHandle } from "./components/SpecEditor";
import { FormDialog, type Field } from "./components/FormDialog";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { ContractView } from "./components/Contract";
import { DocsPreview } from "./components/DocsPreview";
import { GovernancePanel } from "./components/GovernancePanel";
import { runSecurityChecks } from "./security-checks";

const FAMILY_LABEL: Record<SpecFamily, string> = {
  "swagger-2.0": "Swagger 2.0",
  "openapi-3.0": "OpenAPI 3.0",
  "openapi-3.1": "OpenAPI 3.1",
  "openapi-3.2": "OpenAPI 3.2",
  "asyncapi-2": "AsyncAPI 2",
  "asyncapi-3": "AsyncAPI 3",
};

const STATE_LABEL: Record<LangState, string> = {
  starting: "Iniciando",
  ready: "Listo",
  restarting: "Reiniciando",
  failed: "Con errores",
  stopped: "Detenido",
};

const RAIL: Array<{ icon: IconName; label: string }> = [
  { icon: "file", label: "Diseño" },
  { icon: "tag", label: "Versiones" },
  { icon: "shield", label: "Gobernanza" },
  { icon: "cycle", label: "Ciclo ix" },
  { icon: "book", label: "Documentación" },
];

const SEVERITY: Record<Severity, { word: string; cls: string }> = {
  error: { word: "Error", cls: "e" },
  warning: { word: "Aviso", cls: "w" },
  info: { word: "Info", cls: "i" },
  hint: { word: "Pista", cls: "h" },
};

/** Wait this long after the last keystroke before asking the host to check the document again. */
const ANALYZE_DELAY_MS = 250;

type Reading = { analysis: DocumentAnalysis } | { error: RpcError } | null;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Wait this long after the cursor stops before updating the breadcrumb. */
const PATH_DELAY_MS = 120;

const METHOD_CLASS: Record<string, string> = { GET: "m-get", POST: "m-post", PUT: "m-put", PATCH: "m-patch", DELETE: "m-delete", SEND: "m-post", RECEIVE: "m-get" };
const METHOD_SHORT: Record<string, string> = { DELETE: "DEL", RECEIVE: "RECV", OPTIONS: "OPT" };

/** The editor's questions go to the language host; any failure just means "nothing to offer". */
const services: EditorServices = {
  complete: async (cursor) => {
    const outcome = await window.specix.lang.complete(cursor);
    return outcome.ok ? outcome.value : null;
  },
  hover: async (cursor) => {
    const outcome = await window.specix.lang.hover(cursor);
    return outcome.ok ? outcome.value : null;
  },
  definition: async (cursor) => {
    const outcome = await window.specix.lang.definition(cursor);
    return outcome.ok ? outcome.value : null;
  },
};

const HTTP = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]);
/** Same anchors as the core's docs model: lower-case words joined by dashes. */
const anchorOf = (...parts: string[]) =>
  parts
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

/** The operation the cursor is in, as a docs anchor. */
function anchorAt(path: string[]): string | null {
  const [section, name, method] = path;
  if (!name || !method || !HTTP.has(method)) return null;
  if (section === "paths") return anchorOf(method, name);
  if (section === "webhooks") return anchorOf("webhook", method, name);
  return null;
}

/** Wait this long after the last keystroke before rebuilding the preview. */
const DOCS_DELAY_MS = 400;

/** Next minor version: 1.2.3 → 1.3.0. */
function nextMinor(version: string): string {
  const [major = "1", minor = "0"] = version.split("-")[0]!.split(".");
  return `${major}.${Number(minor) + 1}.0`;
}

type DialogState = { type: "api" } | { type: "version"; from: string } | null;

/** Outline grouped as the sidebar shows it: operations by tag first, then channels and components. */
function groupOutline(items: OutlineItem[]): Array<{ title: string; items: OutlineItem[] }> {
  const groups = new Map<string, OutlineItem[]>();
  for (const item of items) {
    const title = item.kind === "component" ? `components · ${item.group}` : item.group;
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return [...groups.entries()].map(([title, list]) => ({ title, items: list }));
}

function useLangStatus(): LangStatus | null {
  const [status, setStatus] = useState<LangStatus | null>(null);
  useEffect(() => {
    const off = window.specix.lang.onStatus(setStatus);
    void window.specix.lang.status().then((s) => s && setStatus((current) => current ?? s));
    return off;
  }, []);
  return status;
}

export function App() {
  const lang = useLangStatus();
  const [text, setText] = useState(DEMO_SPEC);
  const [reading, setReading] = useState<Reading>(null);
  const [ping, setPing] = useState<PingResult | RpcError | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [cursor, setCursor] = useState<Position>({ line: 1, column: 1 });
  const [path, setPath] = useState<string[]>([]);
  const editor = useRef<SpecEditorHandle>(null);
  const checks = useMemo(runSecurityChecks, []);
  const ready = lang?.state === "ready";
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  /** The open workspace file; null shows the demo definition. */
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [saved, setSaved] = useState(DEMO_SPEC);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dirty = file !== null && !file.readOnly && text !== saved;
  const [docs, setDocs] = useState<{ model: DocModel | null; stale: boolean }>({ model: null, stale: false });
  const [rightTab, setRightTab] = useState<"docs" | "gobernanza" | "diagnostico">("docs");
  const [view, setView] = useState<"codigo" | "contrato">("codigo");
  const [problemFilter, setProblemFilter] = useState<"todos" | "esquema" | "guia">("todos");
  // Each file starts showing all its problems.
  // Each file opens in a fresh editor, with the cursor at the start.
  useEffect(() => {
    setProblemFilter("todos");
    setCursor({ line: 1, column: 1 });
  }, [file?.path]);

  useEffect(() => {
    void window.specix.app.info().then(setInfo);
    void window.specix.workspace.get().then(setWorkspace);
    return window.specix.workspace.onChanged(setWorkspace);
  }, []);

  const say = useCallback((tone: "ok" | "err", text: string) => setNotice({ tone, text }), []);

  /** Opens a workspace file, asking first if the current one has unsaved changes. */
  const openFile = useCallback(
    async (path: string, force = false) => {
      if (!force && dirty && file && path !== file.path && !window.confirm(`${file.path} tiene cambios sin guardar. ¿Descartarlos?`)) return;
      const outcome = await window.specix.workspace.read(path);
      if (!outcome.ok) return say("err", outcome.error.message);
      setFile(outcome.value);
      setText(outcome.value.text);
      setSaved(outcome.value.text);
      setNotice(null);
    },
    [dirty, file, say],
  );

  // When a workspace opens, show the entry of its first API.
  useEffect(() => {
    if (!workspace) return setFile(null);
    if (file && workspace.root) return;
    const first = workspace.apis[0]?.versions.at(-1);
    if (first) void openFile(first.entry, true);
    // Only when the workspace itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.root]);

  const save = useCallback(async () => {
    if (!file || file.readOnly) return;
    const outcome = await window.specix.workspace.write(file.path, text);
    if (!outcome.ok) return say("err", outcome.error.message);
    setSaved(text);
    say("ok", `Guardado ${file.path}`);
  }, [file, text, say]);

  const publish = useCallback(async () => {
    const api = file?.api;
    if (!api || api.state === "published") return;
    if (dirty) return say("err", "Guarda los cambios antes de publicar");
    if (!window.confirm(`¿Publicar ${api.name} ${api.version}? Sus archivos quedarán congelados: para cambiarlos hará falta una versión nueva.`)) return;
    const outcome = await window.specix.workspace.publish({ kind: api.kind, name: api.name, version: api.version });
    if (!outcome.ok) return say("err", outcome.error.message);
    await openFile(file.path, true);
    say("ok", `${api.name} ${api.version} publicada`);
  }, [file, dirty, openFile, say]);

  const makeDefault = useCallback(async () => {
    const api = file?.api;
    if (!api) return;
    const outcome = await window.specix.workspace.setDefault({ kind: api.kind, name: api.name, version: api.version });
    if (!outcome.ok) return say("err", outcome.error.message);
    await openFile(file.path, true);
    say("ok", `${api.version} es ahora la versión por defecto de ${api.name}`);
  }, [file, openFile, say]);

  const submitDialog = useCallback(
    async (values: Record<string, string>) => {
      if (!dialog) return;
      setDialogError(null);
      if (dialog.type === "api") {
        const kind = values["kind"] === "domain" ? "domain" : "api";
        const outcome = await window.specix.workspace.createApi({
          kind,
          name: values["name"]!.trim(),
          ...(kind === "api" && values["template"] ? { template: values["template"] } : {}),
          ...(values["title"]?.trim() ? { title: values["title"].trim() } : {}),
        });
        if (!outcome.ok) return setDialogError(outcome.error.message);
        const created = (kind === "api" ? outcome.value.apis : outcome.value.domains).find((a) => a.name === values["name"]!.trim());
        setDialog(null);
        if (created?.versions[0]) await openFile(created.versions[0].entry, true);
        say("ok", `${kind === "api" ? "API" : "Dominio"} ${values["name"]} creado`);
      } else if (file?.api) {
        const api = file.api;
        const outcome = await window.specix.workspace.createVersion({ kind: api.kind, name: api.name, from: dialog.from, to: values["version"]!.trim() });
        if (!outcome.ok) return setDialogError(outcome.error.message);
        const group = api.kind === "api" ? outcome.value.apis : outcome.value.domains;
        const created = group.find((a) => a.name === api.name)?.versions.find((v) => v.version === values["version"]!.trim());
        setDialog(null);
        if (created) await openFile(created.entry, true);
        say("ok", `Versión ${values["version"]} creada como borrador`);
      }
    },
    [dialog, file, openFile, say],
  );

  const dialogFields: Field[] | null = !dialog
    ? null
    : dialog.type === "api"
      ? [
          { name: "name", label: "Nombre", value: "", hint: "Minúsculas, números y guiones; es el nombre de la carpeta", mono: true },
          { name: "title", label: "Título", value: "", hint: "Opcional; va en info.title" },
          { name: "kind", label: "Tipo", value: "api", options: [{ value: "api", label: "API" }, { value: "domain", label: "Dominio (componentes reutilizables)" }] },
          {
            name: "template",
            label: "Plantilla",
            value: workspace?.templates[0]?.name ?? "rest-basica",
            options: (workspace?.templates ?? []).map((t) => ({ value: t.name, label: t.name })),
          },
        ]
      : [{ name: "version", label: "Nueva versión", value: nextMinor(dialog.from), hint: `Copia de ${dialog.from}; se crea como borrador`, mono: true }];

  // Re-read the document whenever it changes, and again once a restarted host is back.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.specix.lang.analyze(text, file?.path).then((outcome) => {
        if (cancelled) return;
        setReading(outcome.ok ? { analysis: outcome.value } : { error: outcome.error });
        setSelected(null);
      });
    }, ANALYZE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, ready, lang?.pid, file?.path]);

  const measure = useCallback(async () => {
    const outcome = await window.specix.lang.ping();
    setPing(outcome.ok ? outcome.value : outcome.error);
  }, []);

  // Documentation preview, rebuilt a little after typing stops; a broken document keeps the last good one.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.specix.lang.docs(text, file?.path).then((outcome) => {
        if (cancelled) return;
        if (outcome.ok && outcome.value) setDocs({ model: outcome.value, stale: false });
        else setDocs((d) => ({ model: d.model, stale: d.model !== null }));
      });
    }, DOCS_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, ready, lang?.pid, file?.path]);

  const exportDocs = useCallback(async () => {
    const outcome = await window.specix.docs.export({ text });
    if (!outcome.ok) return say("err", outcome.error.message);
    if (!outcome.value) return;
    const { dir, pages, problems } = outcome.value;
    say(problems.length ? "err" : "ok", `${pages === 1 ? "1 página" : `${pages} páginas`} en ${dir}${problems.length ? ` · ${problems.length} con problemas` : ""}`);
  }, [text, say]);

  // Breadcrumb: the path of the node under the cursor, asked once the cursor rests.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.specix.lang.path({ text, ...cursor }).then((outcome) => {
        if (!cancelled && outcome.ok) setPath(outcome.value);
      });
    }, PATH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, cursor, ready]);

  /** Selects the diagnostic's range in the editor so the user lands on it. */
  const reveal = useCallback((d: Diagnostic, index: number) => {
    setSelected(index);
    editor.current?.reveal(d.range);
  }, []);

  const goToLine = useCallback((line: number) => {
    editor.current?.reveal({ start: { line, column: 1 }, end: { line, column: 1 } });
  }, []);

  const summary = reading && "analysis" in reading ? reading.analysis : null;
  const problems = summary?.diagnostics ?? [];
  const errors = problems.filter((d) => d.severity === "error").length;
  const notes = problems.length - errors;
  const guideProblems = problems.filter((d) => d.source === "guía").length;
  const shown = problems.map((d, i) => ({ d, i })).filter(({ d }) => problemFilter === "todos" || (problemFilter === "guia") === (d.source === "guía"));
  const fileRole = file?.path.startsWith("guias/") ? "guide" : file?.api?.kind === "domain" ? "domain" : file?.api && !file.api.entry ? "fragment" : "api";
  const spec = summary?.family ? FAMILY_LABEL[summary.family] : "—";
  const lines = text.split("\n").length;
  // While a keystroke breaks the YAML the outline keeps the last version that could be read.
  const lastOutline = useRef<OutlineItem[]>([]);
  const readable = summary !== null && !summary.diagnostics.some((d) => d.source === "sintaxis");
  if (readable) lastOutline.current = summary.outline;
  const outline = useMemo(() => groupOutline(readable ? summary.outline : lastOutline.current), [summary, readable]);
  const state = !summary
    ? "leyendo…"
    : problems.length === 0
      ? "válida según el esquema oficial"
      : errors > 0
        ? count(errors, "error", "errores")
        : guideProblems === notes
          ? `válida · ${count(guideProblems, "nota de la guía", "notas de la guía")}`
          : count(notes, "nota", "notas");

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">Specix</span>
        <button type="button" className="crumb" onClick={() => void window.specix.workspace.openDialog()} title="Abrir otro espacio de trabajo" data-testid="ws-name">
          {workspace ? <b>{workspace.name}</b> : "Sin espacio de trabajo"}
        </button>
        {file?.api ? (
          <span className="apipill" data-testid="api-pill">
            <b>{file.api.name}</b>
            <span className="mono ver">{file.api.version}</span>
            <span className="muted">{file.api.state === "published" ? "publicada" : "borrador"}</span>
            {file.api.isDefault && <Icon name="flag" size={12} label="por defecto" />}
          </span>
        ) : (
          summary?.title && (
            <span className="apipill" data-testid="api-pill">
              <b>{summary.title}</b>
              {summary.apiVersion && <span className="mono ver">{summary.apiVersion}</span>}
              <span className="muted">{file ? "plantilla" : "demostración"}</span>
            </span>
          )
        )}
      </header>

      <nav className="rail" aria-label="Secciones">
        {RAIL.map((item, i) => {
          // Design and governance work on the open definition; the other sections come later.
          const governance = item.icon === "shield";
          const available = i === 0 || governance;
          const current = governance ? rightTab === "gobernanza" : i === 0 && rightTab !== "gobernanza";
          return (
            <button
              key={item.icon}
              type="button"
              title={available ? item.label : `${item.label} · próximamente`}
              aria-label={item.label}
              aria-current={current ? "page" : undefined}
              disabled={!available}
              onClick={available ? () => setRightTab(governance ? "gobernanza" : "docs") : undefined}
              data-testid={governance ? "rail-governance" : undefined}
            >
              <Icon name={item.icon} size={18} />
            </button>
          );
        })}
        <span className="spacer" />
        <button type="button" title="Agentes (MCP) · próximamente" aria-label="Agentes (MCP)" disabled>
          <Icon name="bot" size={18} />
        </button>
        <button type="button" title="Ajustes · próximamente" aria-label="Ajustes" disabled>
          <Icon name="sliders" size={18} />
        </button>
      </nav>

      <aside className="sidebar" aria-label="Espacio de trabajo">
        <div className="side-head">
          <h2>Espacio de trabajo</h2>
          {workspace && (
            <button type="button" className="icon-btn" title="Nueva API o dominio" aria-label="Nueva API o dominio" onClick={() => setDialog({ type: "api" })} data-testid="new-api">
              <Icon name="plus" size={16} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Abrir carpeta" aria-label="Abrir carpeta" onClick={() => void window.specix.workspace.openDialog()}>
            <Icon name="folder" size={16} />
          </button>
        </div>
        {workspace ? (
          <WorkspaceTree workspace={workspace} openPath={file?.path ?? null} dirty={dirty} errors={errors} onOpen={(path) => void openFile(path)} />
        ) : (
          <ul className="tree">
            <li className="side-group">Sin espacio de trabajo</li>
            <li>
              <span className="row l2" aria-selected="true">
                <Icon name="file" size={14} />
                <span className="name">demostración</span>
                {errors > 0 && <span className="n-err mono">{errors}</span>}
              </span>
            </li>
            <li className="side-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.specix.workspace.openDialog()}>
                Abrir carpeta…
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.specix.workspace.createDialog()}>
                Crear espacio de trabajo…
              </button>
            </li>
          </ul>
        )}
        <div className="side-block outline-block">
          <p className="side-title">
            Estructura <span className="muted">{file ? file.path.split("/").at(-1) : "demostración"}</span>
          </p>
          {outline.length === 0 && <p>Las operaciones, canales y componentes del documento aparecen aquí.</p>}
          <ul className="outline" data-testid="outline">
            {outline.map((group) => (
              <li key={group.title}>
                <span className="outline-group">{group.title}</span>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.pointer}>
                      <button type="button" className="outline-row" onClick={() => goToLine(item.line)} title={`Línea ${item.line}`}>
                        {item.method && <span className={`meth ${METHOD_CLASS[item.method] ?? ""}`}>{METHOD_SHORT[item.method] ?? item.method}</span>}
                        <span className="mono label">{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="main">
        <div className="reqline">
          <span className="segctl viewswitch" role="group" aria-label="Vista">
            <button type="button" aria-pressed={view === "codigo"} onClick={() => setView("codigo")} data-testid="view-code">
              Código
            </button>
            <button type="button" aria-pressed={view === "contrato"} onClick={() => setView("contrato")} data-testid="view-contract">
              Contrato
            </button>
          </span>
          <div className="urlbox">
            <span className="lbl">
              Spec<b data-testid="spec-family">{spec}</b>
            </span>
            <span className="url mono" data-testid="file-path">
              {file ? (
                <>
                  <span className="muted">{file.path.slice(0, file.path.lastIndexOf("/") + 1)}</span>
                  {file.path.slice(file.path.lastIndexOf("/") + 1)}
                </>
              ) : (
                <>
                  <span className="muted">demostración/</span>openapi.yaml
                </>
              )}
            </span>
            <span className={errors ? "tail err-t" : "tail"} data-testid="doc-state">
              {state}
            </span>
          </div>
          {!file && (
            <button type="button" className="btn btn-secondary" onClick={() => setText(DEMO_SPEC)} disabled={text === DEMO_SPEC}>
              Restaurar ejemplo
            </button>
          )}
          {file?.api && (
            <button type="button" className="btn btn-secondary" onClick={() => setDialog({ type: "version", from: file.api!.version })} data-testid="new-version">
              Nueva versión
            </button>
          )}
          {file?.api && !file.api.isDefault && file.api.state === "published" && (
            <button type="button" className="btn btn-secondary" onClick={() => void makeDefault()}>
              Por defecto
            </button>
          )}
          {file?.api && file.api.state === "draft" && (
            <button type="button" className={dirty ? "btn btn-secondary" : "btn btn-primary"} onClick={() => void publish()} data-testid="publish">
              Publicar {file.api.version}
            </button>
          )}
          {file && !file.readOnly && (
            <button type="button" className={dirty ? "btn btn-primary" : "btn btn-secondary"} onClick={() => void save()} disabled={!dirty} data-testid="save">
              Guardar <kbd>Ctrl S</kbd>
            </button>
          )}
        </div>

        {view === "contrato" && <ContractView model={docs.model} stale={docs.stale} activeAnchor={anchorAt(path)} />}
        <div className="split" hidden={view !== "codigo"}>
          <div className="pane">
            <div className="subtabs">
              <span className="subtab">Código</span>
              <span className="end muted">
                {summary ? summary.format.toUpperCase() : "—"} · {lines} líneas · Ctrl+Espacio sugiere · F12 va a la definición
              </span>
            </div>
            <div className="crumbs mono" data-testid="crumbs">
              {path.length === 0 ? <span className="muted">raíz</span> : path.map((segment, i) => (
                <span key={i} className={i === path.length - 1 ? "seg last" : "seg"}>
                  {segment}
                </span>
              ))}
              <span className="end">
                Ln {cursor.line}, Col {cursor.column}
              </span>
            </div>
            {file?.readOnly && (
              <div className="banner" data-testid="read-only">
                <Icon name="lock" size={14} />
                Versión publicada: solo lectura. Para cambiarla, crea una versión nueva.
              </div>
            )}
            {notice && (
              <div className={`banner ${notice.tone}`} role="status" data-testid="notice">
                {notice.text}
                <button type="button" className="link-btn" onClick={() => setNotice(null)}>
                  Cerrar
                </button>
              </div>
            )}
            <div className="editor-wrap">
              <SpecEditor
                // One editor per file: each starts at the top with its own undo history.
                key={file?.path ?? "demo"}
                ref={editor}
                value={text}
                onChange={setText}
                format={summary?.format ?? (text.trimStart().startsWith("{") ? "json" : "yaml")}
                diagnostics={problems}
                services={services}
                onCursor={setCursor}
                onSave={() => void save()}
                readOnly={file?.readOnly ?? false}
                label="Definición de la API"
                testId="source"
              />
            </div>
            <div className="problems">
              <div className="subtabs">
                <span className="subtab">
                  Problemas <span className={errors ? "n err" : "n"}>{problems.length}</span>
                </span>
                <span className="end segctl" role="group" aria-label="Qué problemas mostrar">
                  <button type="button" aria-pressed={problemFilter === "todos"} onClick={() => setProblemFilter("todos")}>
                    Todos
                  </button>
                  <button type="button" aria-pressed={problemFilter === "esquema"} onClick={() => setProblemFilter("esquema")} data-testid="filter-schema">
                    Esquema <span className="mono">{problems.length - guideProblems}</span>
                  </button>
                  <button type="button" aria-pressed={problemFilter === "guia"} onClick={() => setProblemFilter("guia")} data-testid="filter-guide">
                    Guía <span className="mono">{guideProblems}</span>
                  </button>
                </span>
              </div>
              <ul className="plist" data-testid="problems">
                {reading && "error" in reading && (
                  <li className="pr">
                    <span className="sev e">Error</span>
                    <span className="msg">No se pudo revisar: {reading.error.code}</span>
                    <span />
                    <span />
                  </li>
                )}
                {summary && problems.length === 0 && (
                  <li className="note">
                    {fileRole === "guide"
                      ? "Sin problemas: la guía usa funciones, severidades y formatos que Specix conoce."
                      : `Sin problemas: la definición cumple el esquema oficial ${summary.schema ?? ""}${summary.guide ? ` y la guía ${summary.guide.name.split(/[\\/]/).at(-1)}` : ""}; sus referencias internas existen.`}
                  </li>
                )}
                {summary && problems.length > 0 && shown.length === 0 && <li className="note">Nada en este filtro.</li>}
                {shown.map(({ d, i }) => (
                  <li key={`${d.code}-${d.pointer}-${i}`}>
                    <button
                      type="button"
                      className="pr"
                      aria-selected={selected === i}
                      onClick={() => reveal(d, i)}
                      title={`${d.code} · ${d.pointer || "/"}`}
                      data-testid="problem"
                    >
                      <span className={`sev ${SEVERITY[d.severity].cls}`}>{SEVERITY[d.severity].word}</span>
                      <span className="msg">{d.message}</span>
                      <span className="src">{d.source}</span>
                      <span className="loc mono">
                        {d.range.start.line}:{d.range.start.column}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pane">
            <div className="subtabs" role="tablist">
              <button type="button" role="tab" className="subtab" aria-selected={rightTab === "docs"} onClick={() => setRightTab("docs")} data-testid="tab-docs">
                Documentación
              </button>
              <button type="button" role="tab" className="subtab" aria-selected={rightTab === "gobernanza"} onClick={() => setRightTab("gobernanza")} data-testid="tab-gobernanza">
                Gobernanza {guideProblems > 0 && <span className="n">{guideProblems}</span>}
              </button>
              <button type="button" role="tab" className="subtab" aria-selected={rightTab === "diagnostico"} onClick={() => setRightTab("diagnostico")} data-testid="tab-diagnostico">
                Diagnóstico
              </button>
              <span className="end">
                <button type="button" className="link-btn" onClick={() => void exportDocs()} title={workspace ? "Genera el sitio de todo el espacio de trabajo" : "Genera una página con esta definición"} data-testid="export-docs">
                  Exportar sitio…
                </button>
              </span>
            </div>
            <div className="pane-body" hidden={rightTab !== "docs"}>
              <DocsPreview model={docs.model} stale={docs.stale} activeAnchor={anchorAt(path)} />
            </div>
            <div className="pane-body" hidden={rightTab !== "gobernanza"}>
              <GovernancePanel
                analysis={summary}
                guideFile={workspace ? workspace.guide : undefined}
                fileRole={fileRole}
                onOpenGuide={workspace?.guide && file?.path !== workspace.guide ? () => void openFile(workspace.guide!) : null}
                onReveal={(d) => {
                  const index = problems.indexOf(d);
                  if (index >= 0) reveal(d, index);
                }}
              />
            </div>
            <div className="pane-body" hidden={rightTab !== "diagnostico"}>
              <h2 className="section-label">Documento <span>leído por el servicio de lenguaje</span></h2>
              <dl className="facts">
                <dt>Especificación</dt>
                <dd className="mono">{summary?.specVersion ? `${spec} (${summary.specVersion})` : spec}</dd>
                <dt>API</dt>
                <dd className="mono" data-testid="doc-title">
                  {summary?.title ? `${summary.title}${summary.apiVersion ? ` ${summary.apiVersion}` : ""}` : "—"}
                </dd>
                <dt>Operaciones</dt>
                <dd className="mono" data-testid="doc-operations">{summary?.operations ?? "—"}</dd>
                <dt>Esquema oficial</dt>
                <dd className="mono" data-testid="doc-schema">{summary?.schema ?? "—"}</dd>
                <dt>Revisión</dt>
                <dd className="mono">{summary ? `${summary.durationMs} ms` : "—"}</dd>
              </dl>

              <h2 className="section-label">Servicio de lenguaje <span>proceso propio, aislado de la ventana</span></h2>
              <dl className="facts">
                <dt>Estado</dt>
                <dd>
                  <span className={`state state-${lang?.state ?? "stopped"}`} data-testid="lang-state">
                    {lang ? STATE_LABEL[lang.state] : "—"}
                  </span>
                </dd>
                <dt>Proceso</dt>
                <dd className="mono" data-testid="lang-pid">{lang?.pid ?? "—"}</dd>
                <dt>Reinicios</dt>
                <dd className="mono" data-testid="lang-restarts">{lang?.restarts ?? 0}</dd>
                <dt>Ida y vuelta</dt>
                <dd className="mono with-action" data-testid="lang-ping">
                  {ping === null ? "—" : "roundTripMs" in ping ? `${ping.roundTripMs} ms` : ping.code}
                  <button type="button" className="link-btn" onClick={measure} disabled={!ready} data-testid="lang-measure">
                    Medir
                  </button>
                </dd>
              </dl>

              <h2 className="section-label">
                Aislamiento de la interfaz <span className="mono">{checks.filter((c) => c.passed).length}/{checks.length}</span>
              </h2>
              <ul className="checks">
                {checks.map((check) => (
                  <li key={check.id} data-testid={`check-${check.id}`} data-passed={check.passed}>
                    <span className={check.passed ? "ok" : "err"}>
                      <Icon name={check.passed ? "check" : "x"} size={14} />
                    </span>
                    <span className="check-label">{check.label}</span>
                    <span className={`check-result ${check.passed ? "ok" : "err"}`}>{check.passed ? "CORRECTO" : "FALLA"}</span>
                    <span className="check-detail">{check.detail}</span>
                  </li>
                ))}
              </ul>

              <h2 className="section-label">Versiones</h2>
              <dl className="facts">
                <dt>Specix</dt>
                <dd className="mono">{info ? `${info.version}${info.packaged ? "" : " (desarrollo)"}` : "—"}</dd>
                <dt>Electron</dt>
                <dd className="mono">{info?.electron ?? "—"}</dd>
                <dt>Chromium</dt>
                <dd className="mono">{info?.chrome ?? "—"}</dd>
                <dt>Node.js</dt>
                <dd className="mono">{info?.node ?? "—"}</dd>
                <dt>Sistema</dt>
                <dd className="mono">{info ? `${info.platform} ${info.arch}` : "—"}</dd>
              </dl>
            </div>
          </div>
        </div>
      </main>

      {dialog && dialogFields && (
        <FormDialog
          key={dialog.type}
          title={dialog.type === "api" ? "Nueva API o dominio" : `Nueva versión de ${file?.api?.name ?? ""}`}
          fields={dialogFields}
          submit={dialog.type === "api" ? "Crear" : "Crear versión"}
          error={dialogError}
          onSubmit={(values) => void submitDialog(values)}
          onCancel={() => {
            setDialog(null);
            setDialogError(null);
          }}
        />
      )}

      <footer className="statusbar">
        <span className={ready ? "run-dot on" : "run-dot"}>Servicio de lenguaje: {lang ? STATE_LABEL[lang.state].toLowerCase() : "—"}</span>
        <span className={errors ? "err-t" : undefined}>{problems.length === 0 ? "Sin problemas" : count(problems.length, "problema", "problemas")}</span>
        {workspace && (
          <span>
            Espacio de trabajo <span className="mono">{workspace.root}</span>
          </span>
        )}
        {dirty && <span>Sin guardar</span>}
        <span className="end">{info ? `Specix ${info.version}` : ""}</span>
      </footer>
    </div>
  );
}
