import type { ApiView, VersionView, WorkspaceView } from "@shared/ipc";
import { Icon } from "../Icon";

export interface VersionRef {
  kind: "api" | "domain";
  name: string;
  version: string;
}

interface Props {
  workspace: WorkspaceView | null;
  /** Path of the open file, to mark the version being edited. */
  openPath: string | null;
  onOpen(entry: string): void;
  onPublish(ref: VersionRef): void;
  onDefault(ref: VersionRef): void;
  onNewVersion(ref: VersionRef): void;
}

const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—");

function ApiCard({ api, kind, openPath, onOpen, onPublish, onDefault, onNewVersion }: { api: ApiView; kind: "api" | "domain" } & Omit<Props, "workspace">) {
  const latest = api.versions.at(-1);
  const editing = (v: VersionView) => openPath !== null && openPath.startsWith(`${v.dir}/`);
  return (
    <section className="vcard" aria-labelledby={`v-${kind}-${api.name}`} data-testid={`versions-${api.name}`}>
      <div className="vcard-head">
        <h2 id={`v-${kind}-${api.name}`}>{api.name}</h2>
        <span className="muted">{kind === "api" ? "API" : "Dominio"}</span>
        <span className="muted">
          {api.versions.length === 1 ? "1 versión" : `${api.versions.length} versiones`}
          {api.defaultVersion ? ` · por defecto ${api.defaultVersion}` : " · sin versión por defecto"}
        </span>
        {latest && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNewVersion({ kind, name: api.name, version: latest.version })}>
            <Icon name="plus" size={14} /> Nueva versión
          </button>
        )}
      </div>
      <table className="vtable">
        <thead>
          <tr>
            <th>Versión</th>
            <th>Estado</th>
            <th>Publicada</th>
            <th>Archivos</th>
            <th aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          {[...api.versions].reverse().map((v) => {
            const ref = { kind, name: api.name, version: v.version };
            return (
              <tr key={v.version} aria-current={editing(v) ? "true" : undefined}>
                <td className="mono ver">
                  {v.version}
                  {v.isDefault && <Icon name="flag" size={12} label="por defecto" />}
                </td>
                <td>
                  <span className={`vstate ${v.state}`}>{v.state === "published" ? "Publicada" : "Borrador"}</span>
                  {v.modified && (
                    <span className="err-t vwarn" title="Sus archivos cambiaron después de publicarla">
                      cambió tras publicarse
                    </span>
                  )}
                </td>
                <td className="mono">{dateOf(v.publishedAt)}</td>
                <td className="mono">{v.files.length}</td>
                <td className="vactions">
                  {v.state === "draft" && (
                    <button type="button" className="link-btn" onClick={() => onPublish(ref)} data-testid={`v-publish-${api.name}-${v.version}`}>
                      Publicar
                    </button>
                  )}
                  {v.state === "published" && !v.isDefault && (
                    <button type="button" className="link-btn" onClick={() => onDefault(ref)}>
                      Por defecto
                    </button>
                  )}
                  <button type="button" className="link-btn" onClick={() => onOpen(v.entry)} data-testid={`v-open-${api.name}-${v.version}`}>
                    {editing(v) ? "Abierta" : "Abrir"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Every API and domain of the workspace with its versions: drafts to edit, published ones frozen. */
export function VersionsView(props: Props) {
  const { workspace } = props;
  const groups: Array<{ kind: "api" | "domain"; items: ApiView[] }> = workspace
    ? [
        { kind: "api", items: workspace.apis },
        { kind: "domain", items: workspace.domains },
      ]
    : [];
  const total = workspace ? workspace.apis.length + workspace.domains.length : 0;
  return (
    <div className="settings versions" data-testid="versions">
      <div className="page-head">
        <h1>Versiones</h1>
        <span className="page-sub">Los borradores se editan; al publicar, una versión queda congelada y los cambios van en una nueva</span>
      </div>
      {!workspace && <p className="empty-note">Abre o crea un espacio de trabajo para versionar tus APIs. La demostración no tiene versiones.</p>}
      {workspace && total === 0 && <p className="empty-note">Este espacio de trabajo aún no tiene APIs. Crea una con el botón + del panel izquierdo.</p>}
      {groups.map((g) => g.items.map((api) => <ApiCard key={`${g.kind}-${api.name}`} api={api} kind={g.kind} {...props} />))}
      {total > 0 && <p className="empty-note">Comparar dos versiones y marcar los cambios incompatibles llega en la siguiente entrega.</p>}
    </div>
  );
}
