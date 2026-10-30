import { useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo, UpdateState, WorkspaceView } from "@shared/ipc";
import { DEFAULT_PREFS, type Prefs, type Theme } from "@shared/prefs";
import { Icon } from "../Icon";
import { runSecurityChecks } from "../security-checks";

const THEME_OPTIONS: Array<{ id: Theme; label: string; hint: string }> = [
  { id: "system", label: "Sistema", hint: "Sigue a Windows" },
  { id: "light", label: "Claro", hint: "Siempre claro" },
  { id: "dark", label: "Oscuro", hint: "Siempre oscuro" },
];

const UPDATE_TEXT: Record<UpdateState["status"], string> = {
  disabled: "Las versiones de desarrollo no se actualizan solas.",
  idle: "Todavía no se ha buscado una versión nueva.",
  checking: "Buscando una versión nueva…",
  current: "Tienes la última versión.",
  downloading: "Descargando la versión nueva…",
  ready: "La versión nueva está lista.",
  error: "No se pudo buscar.",
};

/** Number input that only commits (clamped) on blur or Enter, so typing "16" never passes through "1". */
function NumberField({ value, min, max, onCommit, testId, label }: { value: number; min: number; max: number; onCommit: (n: number) => void; testId: string; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const next = Number.isFinite(n) && text.trim() !== "" ? Math.min(max, Math.max(min, n)) : value;
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      className="mono short"
      type="number"
      min={min}
      max={max}
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      data-testid={testId}
    />
  );
}

/** Text input that commits on blur or Enter, never on every keystroke. */
function TextField({ value, onCommit, testId, label, placeholder }: { value: string; onCommit: (s: string) => void; testId: string; label: string; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      type="text"
      value={text}
      aria-label={label}
      placeholder={placeholder}
      maxLength={100}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      data-testid={testId}
    />
  );
}

function Switch({ checked, onChange, title, note, testId }: { checked: boolean; onChange: (on: boolean) => void; title: React.ReactNode; note: string; testId: string }) {
  return (
    <label className="switch">
      <input type="checkbox" className="check" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>
        {title}
        <small>{note}</small>
      </span>
    </label>
  );
}

function Segmented<T extends string | number>({ value, options, onPick, label, testId }: { value: T; options: Array<[T, string]>; onPick: (v: T) => void; label: string; testId: string }) {
  return (
    <span className="segctl" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onPick(v)} data-testid={`${testId}-${v}`}>
          {text}
        </button>
      ))}
    </span>
  );
}

function UpdatesPanel({ prefs, onStartup }: { prefs: Prefs; onStartup: (checkUpdates: boolean) => void }) {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void window.specix.updates.get().then(setState);
    return window.specix.updates.onChanged(setState);
  }, []);
  const busy = !state || state.status === "disabled" || state.status === "checking" || state.status === "downloading";
  return (
    <section className="panel" aria-labelledby="upd-h">
      <div className="panel-head">
        <h2 id="upd-h">Actualizaciones</h2>
      </div>
      <div className="form prefs-form">
        <div className="update-row">
          <span data-testid="update-status">
            {state ? UPDATE_TEXT[state.status] : "—"}
            {state?.version && state.status !== "current" ? ` (${state.version}${state.status === "downloading" && state.percent !== null ? `, ${state.percent} %` : ""})` : ""}
            {state?.status === "error" && state.message ? ` ${state.message}.` : ""}
          </span>
          {state?.status === "ready" ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void window.specix.updates.install()}>
              Reiniciar y actualizar
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void window.specix.updates.check()} data-testid="update-check">
              <Icon name="download" size={14} /> Buscar ahora
            </button>
          )}
        </div>
        <Switch
          checked={prefs.startup.checkUpdates}
          onChange={onStartup}
          title="Buscar al iniciar"
          note="Unos segundos después de abrir Specix. Se consulta la lista de versiones publicadas en GitHub; no se envía nada tuyo."
          testId="pref-check-updates"
        />
        <p className="hint">La versión nueva se descarga en segundo plano y se instala al reiniciar o al cerrar Specix.</p>
      </div>
    </section>
  );
}

function WorkspacePanel({ workspace, prefs, onReopen }: { workspace: WorkspaceView | null; prefs: Prefs; onReopen: (on: boolean) => void }) {
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const change = (patch: { name?: string; guide?: string | null }, done: string) => {
    void window.specix.workspace.updateSettings(patch).then((outcome) => setStatus(outcome.ok ? { tone: "ok", text: done } : { tone: "err", text: outcome.error.message }));
  };
  return (
    <section className="panel" aria-labelledby="ws-h">
      <div className="panel-head">
        <h2 id="ws-h">Espacio de trabajo</h2>
        {workspace && <span className="count">specix.workspace.yaml</span>}
      </div>
      <div className="form prefs-form">
        {workspace ? (
          <>
            <label className="field">
              <span>Nombre</span>
              <TextField value={workspace.name} label="Nombre del espacio de trabajo" onCommit={(name) => change({ name }, "Nombre guardado")} testId="ws-setting-name" />
            </label>
            <label className="field">
              <span>Guía de estilo</span>
              <select value={workspace.guide ?? ""} onChange={(e) => change({ guide: e.target.value || null }, "Guía cambiada: se aplica al revisar cada API")} data-testid="ws-setting-guide">
                <option value="">Guía base incluida</option>
                {workspace.guides.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Carpeta</span>
              <span className="mono path" data-testid="ws-setting-root">{workspace.root}</span>
            </div>
            {status && (
              <p className={`hint ${status.tone === "err" ? "err-t" : "ok-t"}`} role="status" data-testid="ws-setting-status">
                {status.text}
              </p>
            )}
          </>
        ) : (
          <p className="hint">No hay un espacio de trabajo abierto. Specix muestra una definición de demostración.</p>
        )}
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.specix.workspace.openDialog()}>
            <Icon name="folder" size={14} /> Abrir otra carpeta…
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.specix.workspace.createDialog()}>
            <Icon name="plus" size={14} /> Crear espacio de trabajo…
          </button>
        </div>
        <Switch checked={prefs.startup.reopenWorkspace} onChange={onReopen} title="Reabrir el último al iniciar" note="Si se apaga, Specix arranca con la demostración." testId="pref-reopen" />
      </div>
    </section>
  );
}

export function SettingsView({ prefs, save, workspace, info }: { prefs: Prefs; save: (update: (p: Prefs) => Prefs) => void; workspace: WorkspaceView | null; info: AppInfo | null }) {
  const editor = (patch: Partial<Prefs["editor"]>) => save((p) => ({ ...p, editor: { ...p.editor, ...patch } }));
  const reading = (patch: Partial<Prefs["reading"]>) => save((p) => ({ ...p, reading: { ...p.reading, ...patch } }));
  const docs = (patch: Partial<Prefs["docs"]>) => save((p) => ({ ...p, docs: { ...p.docs, ...patch } }));
  const startup = (patch: Partial<Prefs["startup"]>) => save((p) => ({ ...p, startup: { ...p.startup, ...patch } }));
  const isDefault = JSON.stringify(prefs) === JSON.stringify(DEFAULT_PREFS);
  const checks = useMemo(runSecurityChecks, []);
  // The colour picker fires while dragging; only the colour it rests on is stored.
  const [color, setColor] = useState(prefs.docs.color);
  useEffect(() => setColor(prefs.docs.color), [prefs.docs.color]);
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickColor = (value: string) => {
    setColor(value);
    if (colorTimer.current) clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(() => docs({ color: value }), 300);
  };

  return (
    <div className="settings" data-testid="settings">
      <div className="page-head">
        <h1>Ajustes</h1>
        <span className="page-sub">Se guardan en este equipo y se aplican al momento</span>
        <button type="button" className="link-btn reset" disabled={isDefault} onClick={() => save(() => DEFAULT_PREFS)} data-testid="prefs-reset">
          Restablecer valores predeterminados
        </button>
      </div>

      <div className="grid">
        <section className="panel" aria-labelledby="look-h">
          <div className="panel-head">
            <h2 id="look-h">Apariencia</h2>
          </div>
          <div className="theme-pick" role="radiogroup" aria-label="Tema">
            {THEME_OPTIONS.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={prefs.theme === o.id} className="theme-option" onClick={() => save((p) => ({ ...p, theme: o.id }))} data-testid={`theme-${o.id}`}>
                <span className={`theme-swatch ${o.id}`} aria-hidden="true">
                  <span className="sw-rail" />
                  <span className="sw-work">
                    <span className="sw-line" />
                    <span className="sw-line short" />
                    <span className="sw-accent" />
                  </span>
                </span>
                <span className="theme-text">
                  <b>{o.label}</b>
                  <small>{o.hint}</small>
                </span>
                {prefs.theme === o.id && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>

          <div className="panel-head sub">
            <h2>Editor de código</h2>
          </div>
          <div className="form prefs-form">
            <label className="field">
              <span>Tamaño de letra</span>
              <span className="inline">
                <NumberField value={prefs.editor.fontSize} min={11} max={20} onCommit={(fontSize) => editor({ fontSize })} testId="pref-font-size" label="Tamaño de letra del código" /> px
              </span>
            </label>
            <div className="field">
              <span>Sangría</span>
              <Segmented value={prefs.editor.tabSize} options={[[2, "2 espacios"], [4, "4 espacios"]]} onPick={(tabSize) => editor({ tabSize })} label="Sangría" testId="pref-tab" />
            </div>
            <Switch checked={prefs.editor.closeBrackets} onChange={(closeBrackets) => editor({ closeBrackets })} title="Cerrar llaves y comillas" note={'Al escribir {, [ o " se añade su cierre.'} testId="pref-close-brackets" />
            <Switch checked={prefs.editor.lineWrap} onChange={(lineWrap) => editor({ lineWrap })} title="Ajustar líneas largas" note="Las descripciones largas se parten al ancho del editor en vez de desplazarse." testId="pref-wrap" />
            <p className="code-sample mono" aria-hidden="true" style={{ fontSize: prefs.editor.fontSize }}>
              <span className="k">summary</span>: <span className="s">Lista los pedidos de un cliente</span>
            </p>
          </div>
        </section>

        <section className="panel" aria-labelledby="read-h">
          <div className="panel-head">
            <h2 id="read-h">Lectura del contrato</h2>
          </div>
          <div className="form prefs-form">
            <div className="field">
              <span>Al abrir Specix</span>
              <Segmented value={prefs.reading.startView} options={[["codigo", "Código"], ["contrato", "Contrato"]]} onPick={(startView) => reading({ startView })} label="Vista al abrir" testId="pref-start" />
            </div>
            <div className="field">
              <span>Cuerpos y respuestas</span>
              <Segmented value={prefs.reading.payloadView} options={[["ejemplo", "Ejemplo"], ["esquema", "Esquema"]]} onPick={(payloadView) => reading({ payloadView })} label="Cómo se abren los cuerpos" testId="pref-payload" />
            </div>
            <p className="hint field-note">Cómo se abre cada cuerpo en el contrato y en la vista previa: como JSON de ejemplo con datos o como árbol de tipos.</p>
          </div>

          <div className="panel-head sub">
            <h2>Sitio de documentación</h2>
            <span className="hint end-note">para «Exportar sitio…»</span>
          </div>
          <div className="form prefs-form">
            <label className="field">
              <span>Marca</span>
              <TextField value={prefs.docs.brand} label="Nombre que encabeza el sitio" placeholder={workspace?.name ?? "El título de la API"} onCommit={(brand) => docs({ brand: brand.trim() })} testId="pref-brand" />
            </label>
            <div className="field">
              <span>Color</span>
              <span className="inline">
                <input type="color" className="color" value={color} aria-label="Color de la marca" onChange={(e) => pickColor(e.target.value)} data-testid="pref-color" />
                <span className="mono">{color}</span>
                {color !== DEFAULT_PREFS.docs.color && (
                  <button type="button" className="link-btn" onClick={() => pickColor(DEFAULT_PREFS.docs.color)}>
                    Usar el de Specix
                  </button>
                )}
              </span>
            </div>
            <Switch
              checked={prefs.docs.includeDrafts}
              onChange={(includeDrafts) => docs({ includeDrafts })}
              title="Incluir borradores"
              note="Apagado, el sitio solo lleva las versiones publicadas de cada API."
              testId="pref-drafts"
            />
          </div>
        </section>
      </div>

      <div className="grid">
        <WorkspacePanel workspace={workspace} prefs={prefs} onReopen={(reopenWorkspace) => startup({ reopenWorkspace })} />
        <UpdatesPanel prefs={prefs} onStartup={(checkUpdates) => startup({ checkUpdates })} />
      </div>

      <section className="panel data" aria-labelledby="data-h">
        <div className="panel-head">
          <h2 id="data-h">Este equipo</h2>
        </div>
        <dl className="facts">
          <dt>Carpeta del perfil</dt>
          <dd className="with-action">
            <span className="mono" data-testid="profile-path">{info?.profile ?? "—"}</span>
            <button type="button" className="link-btn" onClick={() => void window.specix.prefs.revealProfile()}>
              Mostrar en el explorador
            </button>
          </dd>
          <dt>Specix</dt>
          <dd className="mono" data-testid="app-version">{info ? `${info.version}${info.packaged ? "" : " (desarrollo)"}` : "—"}</dd>
          <dt>Electron</dt>
          <dd className="mono">{info ? `${info.electron} · Chromium ${info.chrome} · Node.js ${info.node}` : "—"}</dd>
          <dt>Sistema</dt>
          <dd className="mono">{info ? `${info.platform} ${info.arch}` : "—"}</dd>
        </dl>
        <div className="panel-head sub">
          <h2>
            Aislamiento de la interfaz <span className="count">{checks.filter((c) => c.passed).length}/{checks.length}</span>
          </h2>
        </div>
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
      </section>
    </div>
  );
}
