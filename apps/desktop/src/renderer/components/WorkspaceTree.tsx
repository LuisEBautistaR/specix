/** Sidebar tree of a workspace: APIs and domains with their versions and files, then style guides and templates. */
import type { ApiView, WorkspaceView } from "@shared/ipc";
import { Icon } from "../Icon";

interface Props {
  workspace: WorkspaceView;
  /** Workspace-relative path of the open file. */
  openPath: string | null;
  dirty: boolean;
  /** Error counts by workspace-relative file, for the open file only (others are not analysed yet). */
  errors: number;
  onOpen(path: string): void;
}

const fileName = (path: string, base: string) => path.slice(base.length + 1);

function Group({ title, items, openPath, dirty, errors, onOpen, testId }: Omit<Props, "workspace"> & { title: string; items: ApiView[]; testId: string }) {
  return (
    <>
      <li className="side-group">{title}</li>
      {items.length === 0 && <li className="side-empty">Ninguna todavía</li>}
      {items.map((api) => (
        <li key={api.dir} data-testid={`${testId}-${api.name}`}>
          <span className="row l1">
            <Icon name="down" size={14} />
            <span className="name">{api.name}</span>
          </span>
          <ul>
            {api.versions.map((v) => (
              <li key={v.dir}>
                <button
                  type="button"
                  className="row l2 version-row"
                  onClick={() => onOpen(v.entry)}
                  title={v.state === "published" ? "Publicada: solo lectura" : "Borrador"}
                  data-testid={`version-${api.name}-${v.version}`}
                >
                  {v.state === "published" ? <Icon name="lock" size={13} /> : <Icon name="file" size={13} />}
                  <span className="mono ver">{v.version}</span>
                  {v.isDefault && <Icon name="flag" size={12} label="por defecto" />}
                  <span className={v.modified ? "sub err-t" : "sub"}>{v.modified ? "cambió tras publicarse" : v.state === "published" ? "publicada" : "borrador"}</span>
                </button>
                <ul>
                  {v.files.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        className="row l3"
                        aria-selected={path === openPath}
                        onClick={() => onOpen(path)}
                        data-testid={`file-${path}`}
                      >
                        <span className="name mono">{fileName(path, v.dir)}</span>
                        {path === openPath && dirty && <span className="unsaved" title="Cambios sin guardar" />}
                        {path === openPath && errors > 0 && <span className="n-err mono">{errors}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

export function WorkspaceTree({ workspace, openPath, dirty, errors, onOpen }: Props) {
  return (
    <ul className="tree" data-testid="workspace-tree">
      <Group title="APIs" items={workspace.apis} openPath={openPath} dirty={dirty} errors={errors} onOpen={onOpen} testId="api" />
      <Group title="Dominios" items={workspace.domains} openPath={openPath} dirty={dirty} errors={errors} onOpen={onOpen} testId="domain" />
      <li className="side-group">Guías de estilo</li>
      {workspace.guides.length === 0 && <li className="side-empty">Se aplica la guía base incluida</li>}
      {workspace.guides.map((g) => (
        <li key={g}>
          <button type="button" className="row" aria-selected={g === openPath} onClick={() => onOpen(g)} data-testid={`guide-${g}`}>
            <Icon name="shield" size={13} />
            <span className="name">{g.split("/").at(-1)}</span>
            {g === workspace.guide && <span className="sub">activa</span>}
            {g === openPath && dirty && <span className="unsaved" title="Cambios sin guardar" />}
            {g === openPath && errors > 0 && <span className="n-err mono">{errors}</span>}
          </button>
        </li>
      ))}
      <li className="side-group">Plantillas</li>
      {workspace.templates.map((t) => (
        <li key={t.file}>
          <button type="button" className="row" aria-selected={t.file === openPath} onClick={() => onOpen(t.file)}>
            <Icon name="template" size={13} />
            <span className="name">{t.name}</span>
          </button>
        </li>
      ))}
      {workspace.problems.map((p) => (
        <li key={`${p.file}-${p.message}`} className="side-problem err-t">
          {p.file}: {p.message}
        </li>
      ))}
    </ul>
  );
}
