/**
 * Live documentation preview, rendered from the model the language host
 * builds. Everything is plain React text: descriptions are shown as written,
 * never injected as HTML. The operation under the editor's cursor opens and
 * scrolls into view.
 */
import { useEffect, useRef, useState } from "react";
import type { DocContent, DocModel, DocOperation, DocSchema } from "@shared/ipc";

const METHOD_CLASS: Record<string, string> = { GET: "m-get", POST: "m-post", PUT: "m-put", PATCH: "m-patch", DELETE: "m-delete", SEND: "m-post", RECEIVE: "m-get" };
const short = (m: string) => (m === "DELETE" ? "DEL" : m);

function Schema({ schema, depth = 0 }: { schema: DocSchema; depth?: number }) {
  return (
    <>
      {schema.properties.length > 0 && depth < 3 && (
        <ul className="schema">
          {schema.properties.map((p) => (
            <li key={p.name}>
              <div className="prop">
                <span className="f mono">
                  {p.name}
                  {p.required && <span className="req">oblig.</span>}
                </span>
                <span className="t mono">{p.schema.ref ?? p.schema.type}</span>
                <span className="dsc">{[p.schema.description, ...p.schema.constraints, p.schema.enum.length ? p.schema.enum.join(" · ") : null].filter(Boolean).join(" · ")}</span>
              </div>
              {p.schema.properties.length > 0 && <Schema schema={p.schema} depth={depth + 1} />}
              {p.schema.items && p.schema.items.properties.length > 0 && <Schema schema={p.schema.items} depth={depth + 1} />}
            </li>
          ))}
        </ul>
      )}
      {schema.properties.length === 0 && schema.items && schema.items.properties.length > 0 && depth < 3 && <Schema schema={schema.items} depth={depth + 1} />}
    </>
  );
}

function Contents({ contents }: { contents: DocContent[] }) {
  return (
    <>
      {contents.map((c) => (
        <div key={c.mediaType} className="content">
          <p className="media">
            <span className="mono">{c.mediaType}</span>
            {c.schema && <span className="mono t">{c.schema.ref ? `${c.schema.ref} · ${c.schema.type}` : c.schema.type}</span>}
          </p>
          {c.schema && <Schema schema={c.schema} />}
          {c.example && <pre className="example mono">{c.example}</pre>}
        </div>
      ))}
    </>
  );
}

function Operation({ op, open, onToggle, active }: { op: DocOperation; open: boolean; onToggle(): void; active: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li ref={ref} className={active ? "op active" : "op"} data-testid={`doc-op-${op.anchor}`}>
      <button type="button" className="op-head" aria-expanded={open} onClick={onToggle}>
        <span className={`meth ${METHOD_CLASS[op.method] ?? ""}`}>{short(op.method)}</span>
        <span className="p mono">{op.path}</span>
        <span className={op.summary ? "s" : "s none"}>{op.summary ?? "sin resumen"}</span>
        {op.deprecated && <span className="tag">obsoleta</span>}
      </button>
      {open && (
        <div className="op-body">
          {op.description && <p className="desc">{op.description}</p>}
          {op.parameters.length > 0 && (
            <>
              <h5>Parámetros</h5>
              <ul className="schema">
                {op.parameters.map((p) => (
                  <li key={`${p.in}-${p.name}`}>
                    <div className="prop">
                      <span className="f mono">
                        {p.name}
                        {p.required && <span className="req">oblig.</span>}
                      </span>
                      <span className="t mono">
                        {p.in} · {p.schema?.type ?? "—"}
                      </span>
                      <span className="dsc">{[p.description, ...(p.schema?.constraints ?? [])].filter(Boolean).join(" · ")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {op.requestBody && (
            <>
              <h5>
                Cuerpo {op.requestBody.required && <span className="req">oblig.</span>}
              </h5>
              <Contents contents={op.requestBody.contents} />
            </>
          )}
          {op.responses.length > 0 && (
            <>
              <h5>Respuestas</h5>
              {op.responses.map((r) => (
                <div key={r.code} className="resp">
                  <p className="resp-row">
                    <span className={`c mono ${/^[23]/.test(r.code) ? "ok" : "err"}`}>{r.code}</span>
                    {r.description}
                    {r.headers.length > 0 && <span className="r mono">{r.headers.join(", ")}</span>}
                  </p>
                  <Contents contents={r.contents} />
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </li>
  );
}

interface Props {
  model: DocModel | null;
  /** Anchor of the operation under the editor's cursor. */
  activeAnchor: string | null;
  stale: boolean;
}

export function DocsPreview({ model, activeAnchor, stale }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (activeAnchor) setOpen((s) => (s.has(activeAnchor) ? s : new Set(s).add(activeAnchor)));
  }, [activeAnchor]);
  if (!model) return <p className="note docs-empty">La vista previa aparece cuando el documento se puede leer.</p>;
  const toggle = (anchor: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(anchor)) next.delete(anchor);
      else next.add(anchor);
      return next;
    });
  const ops = (list: DocOperation[]) => (
    <ul className="ops">
      {list.map((op) => (
        <Operation key={op.anchor} op={op} open={open.has(op.anchor)} onToggle={() => toggle(op.anchor)} active={op.anchor === activeAnchor} />
      ))}
    </ul>
  );
  return (
    <div className="docs" data-testid="docs">
      {stale && <p className="stale">Mostrando la última versión que se pudo leer.</p>}
      <div className="doc-head">
        <h3 data-testid="docs-title">{model.title}</h3>
        {model.version && <span className="ver mono">{model.version}</span>}
        {model.servers[0] && <span className="end mono">{model.servers[0].url}</span>}
      </div>
      {model.description && <p className="doc-desc">{model.description}</p>}
      {model.groups.map((g) => (
        <section key={g.name}>
          <div className="doc-tag">
            {g.name} <span>{g.operations.length === 1 ? "1 operación" : `${g.operations.length} operaciones`}</span>
          </div>
          {ops(g.operations)}
        </section>
      ))}
      {model.webhooks.length > 0 && (
        <section>
          <div className="doc-tag">webhooks</div>
          {ops(model.webhooks)}
        </section>
      )}
      {model.channels.map((c) => (
        <section key={c.anchor}>
          <div className="doc-tag">
            {c.name} {c.address && c.address !== c.name && <span className="mono">{c.address}</span>}
          </div>
          <ul className="ops">
            {c.operations.map((o) => (
              <li key={o.name} className="op">
                <div className="op-head static">
                  <span className={`meth ${METHOD_CLASS[o.action.toUpperCase()] ?? ""}`}>{o.action.toUpperCase().slice(0, 4)}</span>
                  <span className="p mono">{o.name}</span>
                  <span className="s">{o.summary ?? ""}</span>
                </div>
              </li>
            ))}
            {c.messages.map((m) => (
              <li key={m.name} className="op">
                <div className="op-body">
                  <h5>Mensaje {m.name}</h5>
                  {m.payload && <Schema schema={m.payload} />}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {model.schemas.length > 0 && (
        <section>
          <div className="doc-tag">
            esquemas <span>{model.schemas.length}</span>
          </div>
          <ul className="ops">
            {model.schemas.map((s) => (
              <li key={s.anchor} className="op">
                <button type="button" className="op-head" aria-expanded={open.has(s.anchor)} onClick={() => toggle(s.anchor)}>
                  <span className="p mono">{s.name}</span>
                  <span className="s">{s.schema.type}</span>
                </button>
                {open.has(s.anchor) && (
                  <div className="op-body">
                    <Schema schema={s.schema} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
