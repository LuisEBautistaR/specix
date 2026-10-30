/**
 * The contract as a reader sees it: every operation with its parameters, and
 * each body or response as an example with data or as its schema tree.
 * Examples written in the document come first; otherwise the core builds one
 * from the schema. Everything is plain React text, never injected HTML.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DocContent, DocModel, DocOperation, DocSchema } from "@shared/ipc";

export const METHOD_CLASS: Record<string, string> = { GET: "m-get", POST: "m-post", PUT: "m-put", PATCH: "m-patch", DELETE: "m-delete", SEND: "m-post", RECEIVE: "m-get" };

type Schemas = DocModel["schemas"];

/** How bodies open, from Ajustes: as an example with data or as the schema tree. */
export const PayloadViewContext = createContext<"ejemplo" | "esquema">("ejemplo");

/** JSON with its keys, strings, numbers and literals told apart. Text that is not JSON shows as written. */
export function JsonView({ text, testId }: { text: string; testId?: string }) {
  const parts = useMemo(() => {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
    const out: ReactNode[] = [];
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    let last = 0;
    let i = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1]) {
        out.push(
          <span key={i++} className={m[2] ? "j-key" : "j-str"}>
            {m[1]}
          </span>,
        );
        if (m[2]) out.push(m[2]);
      } else if (m[3]) out.push(<span key={i++} className="j-num">{m[3]}</span>);
      else out.push(<span key={i++} className="j-lit">{m[4]}</span>);
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }, [text]);
  return (
    <pre className="json mono" data-testid={testId}>
      {parts ?? text}
    </pre>
  );
}

/** Properties of a schema, with allOf parts (and the components they name) merged into one object. */
function propertiesOf(schema: DocSchema, schemas: Schemas, trail: string[]): DocSchema["properties"] {
  if (schema.properties.length > 0 || schema.variants?.mode !== "allOf") return schema.properties;
  return schema.variants.options.flatMap((o) => {
    if (o.properties.length > 0) return o.properties;
    const target = o.ref && !trail.includes(o.ref) ? schemas.find((s) => s.name === o.ref) : undefined;
    return target ? propertiesOf(target.schema, schemas, [...trail, o.ref!]) : [];
  });
}

const hasBody = (s: DocSchema, schemas: Schemas, trail: string[]) => propertiesOf(s, schemas, trail).length > 0 || !!s.items || (!!s.variants && s.variants.mode !== "allOf");

/** One value in the tree: its type, and what it opens into (a component, an array's items, alternatives). */
function TypeCell({ schema, schemas, trail, open, onToggle }: { schema: DocSchema; schemas: Schemas; trail: string[]; open: boolean; onToggle(): void }) {
  const target = schema.ref ?? schema.items?.ref ?? null;
  const recursive = target !== null && trail.includes(target);
  const expandable = !recursive && ((target !== null && schemas.some((s) => s.name === target)) || (target === null && hasBody(schema.items ?? schema, schemas, trail)));
  const label = schema.items ? (
    <>
      [ <span className="t-ref">{schema.items.ref ?? schema.items.type}</span> ]
    </>
  ) : (
    <span className={schema.ref ? "t-ref" : undefined}>{schema.ref ?? schema.type}</span>
  );
  if (!expandable)
    return (
      <span className="t mono" title={recursive ? "Se repite: ya está abierto más arriba" : undefined}>
        {label}
        {recursive && <span className="rec"> ↺</span>}
      </span>
    );
  return (
    <button type="button" className="t mono t-open" aria-expanded={open} onClick={onToggle}>
      {label}
      <span className="chev" aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
    </button>
  );
}

function detailOf(schema: DocSchema): ReactNode {
  const bits: ReactNode[] = [];
  if (schema.description) bits.push(<span key="d">{schema.description}</span>);
  if (schema.constraints.length) bits.push(<span key="c" className="cons">{schema.constraints.join(" · ")}</span>);
  if (schema.enum.length)
    bits.push(
      <span key="e" className="enum">
        {schema.enum.map((v) => (
          <code key={v}>{v}</code>
        ))}
      </span>,
    );
  return bits.length ? bits : null;
}

/** What a type opens into, once expanded. */
function Expansion({ schema, schemas, trail }: { schema: DocSchema; schemas: Schemas; trail: string[] }) {
  const inner = schema.items ?? schema;
  if (inner.ref) {
    const target = schemas.find((s) => s.name === inner.ref);
    return target ? <SchemaTree schema={target.schema} name={inner.ref} schemas={schemas} trail={[...trail, inner.ref]} /> : null;
  }
  return <SchemaTree schema={inner} schemas={schemas} trail={trail} />;
}

function PropertyRow({ name, required, schema, schemas, trail }: { name: string; required: boolean; schema: DocSchema; schemas: Schemas; trail: string[] }) {
  // Inline objects open on their own; named components open on demand.
  const [open, setOpen] = useState(!schema.ref && !schema.items?.ref && hasBody(schema.items ?? schema, schemas, trail) && trail.length < 3);
  return (
    <li>
      <div className="srow">
        <span className="k mono">
          {name}
          {required && (
            <span className="star" title="Obligatorio">
              *
            </span>
          )}
        </span>
        <TypeCell schema={schema} schemas={schemas} trail={trail} open={open} onToggle={() => setOpen(!open)} />
        <span className="dsc">{detailOf(schema)}</span>
      </div>
      {open && <Expansion schema={schema} schemas={schemas} trail={trail} />}
    </li>
  );
}

/** A schema drawn as a model: braces around an object's properties, brackets around an array. */
export function SchemaTree({ schema, schemas, name, trail = [] }: { schema: DocSchema; schemas: Schemas; name?: string; trail?: string[] }) {
  const props = propertiesOf(schema, schemas, trail);
  const head = name ?? schema.ref;
  if (props.length > 0)
    return (
      <div className="stree">
        <div className="brace mono">
          {head && <span className="t-ref">{head}</span>} {"{"}
          {schema.description && trail.length === 0 && <span className="dsc"> {schema.description}</span>}
        </div>
        <ul>
          {props.map((p) => (
            <PropertyRow key={p.name} name={p.name} required={p.required} schema={p.schema} schemas={schemas} trail={trail} />
          ))}
        </ul>
        <div className="brace mono">{"}"}</div>
      </div>
    );
  if (schema.items)
    return (
      <div className="stree">
        <div className="brace mono">
          {head && <span className="t-ref">{head}</span>} {"["}
        </div>
        <div className="tree-in">
          <Expansion schema={schema} schemas={schemas} trail={trail} />
        </div>
        <div className="brace mono">{"]"}</div>
      </div>
    );
  if (schema.variants && schema.variants.mode !== "allOf")
    return (
      <div className="stree">
        <div className="brace mono">
          {head && <span className="t-ref">{head}</span>} <span className="muted">{schema.variants.mode === "oneOf" ? "uno de" : "alguno de"}</span>
        </div>
        <ul>
          {schema.variants.options.map((o, i) => (
            <PropertyRow key={i} name={`${i + 1}.`} required={false} schema={o} schemas={schemas} trail={trail} />
          ))}
        </ul>
      </div>
    );
  return (
    <div className="stree">
      <div className="srow">
        <span className="t mono">{schema.type}</span>
        <span className="dsc">{detailOf(schema)}</span>
      </div>
    </div>
  );
}

/** A body, response or message: example with data, or its schema. */
export function Payload({ content, schemas, testId }: { content: Pick<DocContent, "mediaType" | "schema" | "example" | "sample">; schemas: Schemas; testId?: string }) {
  const example = content.example ?? content.sample;
  const preferred = useContext(PayloadViewContext);
  const [view, setView] = useState<"ejemplo" | "esquema">(example && preferred === "ejemplo" ? "ejemplo" : "esquema");
  // A new choice in Ajustes applies to bodies already on screen too.
  useEffect(() => setView(example && preferred === "ejemplo" ? "ejemplo" : "esquema"), [preferred, example]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="payload" data-testid={testId}>
      <div className="payload-head">
        <span className="mono media">{content.mediaType}</span>
        {content.schema && <span className="mono t-ref">{content.schema.ref ?? content.schema.type}</span>}
        <span className="end">
          {view === "ejemplo" && example && (
            <>
              <span className="src">{content.example ? "del documento" : "generado del esquema"}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(example).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  });
                }}
              >
                {copied ? "Copiado" : "Copiar"}
              </button>
            </>
          )}
          <span className="segctl" role="group" aria-label="Cómo verlo">
            <button type="button" aria-pressed={view === "ejemplo"} onClick={() => setView("ejemplo")} disabled={!example} data-testid="view-example">
              Ejemplo
            </button>
            <button type="button" aria-pressed={view === "esquema"} onClick={() => setView("esquema")} disabled={!content.schema} data-testid="view-schema">
              Esquema
            </button>
          </span>
        </span>
      </div>
      {view === "ejemplo" && example ? <JsonView text={example} testId="example" /> : content.schema ? <div className="payload-tree"><SchemaTree schema={content.schema} schemas={schemas} /></div> : null}
    </div>
  );
}

function OperationCard({ op, schemas, open, onToggle, active }: { op: DocOperation; schemas: Schemas; open: boolean; onToggle(): void; active: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "start" });
  }, [active]);
  const cls = METHOD_CLASS[op.method] ?? "";
  return (
    <article ref={ref} id={`contrato-${op.anchor}`} className={`card ${cls}${op.deprecated ? " deprecated" : ""}`} data-testid={`contract-op-${op.anchor}`}>
      <button type="button" className="card-head" aria-expanded={open} onClick={onToggle}>
        <span className={`badge ${cls}`}>{op.method}</span>
        <span className="p mono">{op.path}</span>
        <span className={op.summary ? "s" : "s none"}>{op.summary ?? "sin resumen"}</span>
        {op.deprecated && <span className="tag">obsoleta</span>}
        {op.security.length > 0 && <span className="lock" title={`Requiere ${op.security.join(", ")}`}>{op.security.join(", ")}</span>}
        <span className="chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="card-body">
          {(op.description || op.operationId) && (
            <div className="lead">
              {op.description && <p>{op.description}</p>}
              {op.operationId && (
                <p className="opid">
                  operationId <span className="mono">{op.operationId}</span>
                </p>
              )}
            </div>
          )}
          <h4>Parámetros</h4>
          {op.parameters.length === 0 ? (
            <p className="none">Sin parámetros.</p>
          ) : (
            <table className="params">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>En</th>
                  <th>Tipo</th>
                  <th>Descripción</th>
                </tr>
              </thead>
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}-${p.name}`}>
                    <td className="mono k">
                      {p.name}
                      {p.required && <span className="star">*</span>}
                    </td>
                    <td className="muted">{p.in}</td>
                    <td className="mono t">{p.schema?.ref ?? p.schema?.type ?? "—"}</td>
                    <td className="dsc">
                      {p.description}
                      {p.schema && detailOf({ ...p.schema, description: null })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {op.requestBody && (
            <>
              <h4>
                Cuerpo de la petición {op.requestBody.required && <span className="req">oblig.</span>}
              </h4>
              {op.requestBody.description && <p className="dsc-line">{op.requestBody.description}</p>}
              {op.requestBody.contents.map((c) => (
                <Payload key={c.mediaType} content={c} schemas={schemas} testId="request-payload" />
              ))}
            </>
          )}
          <h4>Respuestas</h4>
          <div className="responses">
            {op.responses.map((r) => (
              <section key={r.code} className="response" data-testid={`response-${r.code}`}>
                <div className="response-head">
                  <span className={`code mono ${/^[23]/.test(r.code) ? "ok" : /^default$/.test(r.code) ? "" : "err"}`}>{r.code}</span>
                  <span>{r.description}</span>
                  {r.headers.length > 0 && <span className="hdrs mono">cabeceras: {r.headers.join(", ")}</span>}
                </div>
                {r.contents.map((c) => (
                  <Payload key={c.mediaType} content={c} schemas={schemas} />
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

const FAMILY_LABEL: Record<string, string> = {
  "swagger-2.0": "OpenAPI 2.0",
  "openapi-3.0": "OpenAPI 3.0",
  "openapi-3.1": "OpenAPI 3.1",
  "openapi-3.2": "OpenAPI 3.2",
  "asyncapi-2": "AsyncAPI 2",
  "asyncapi-3": "AsyncAPI 3",
};

interface Props {
  model: DocModel | null;
  stale: boolean;
  /** Operation under the editor's cursor: it opens when the view does. */
  activeAnchor: string | null;
}

/** Full-width reading view of the whole contract. */
export function ContractView({ model, stale, activeAnchor }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(activeAnchor ? [activeAnchor] : []));
  const [focus, setFocus] = useState<string | null>(activeAnchor);
  if (!model) return <p className="note docs-empty">El contrato aparece cuando el documento se puede leer.</p>;
  const all = [...model.groups.flatMap((g) => g.operations), ...model.webhooks];
  const toggle = (anchor: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(anchor)) next.delete(anchor);
      else next.add(anchor);
      return next;
    });
  const jump = (anchor: string) => {
    setOpen((s) => new Set(s).add(anchor));
    setFocus(null);
    requestAnimationFrame(() => setFocus(anchor));
  };
  const everything = [...all.map((o) => o.anchor), ...model.schemas.map((s) => s.anchor), ...model.channels.map((c) => c.anchor)];
  const allOpen = everything.length > 0 && everything.every((a) => open.has(a));
  const cards = (list: DocOperation[]) => list.map((op) => <OperationCard key={op.anchor} op={op} schemas={model.schemas} open={open.has(op.anchor)} onToggle={() => toggle(op.anchor)} active={focus === op.anchor} />);

  return (
    <div className="contract" data-testid="contract">
      <nav className="contract-index" aria-label="Índice del contrato">
        {model.groups.map((g) => (
          <div key={g.name}>
            <p className="ix-group">{g.name}</p>
            {g.operations.map((op) => (
              <button key={op.anchor} type="button" className="ix-row" onClick={() => jump(op.anchor)}>
                <span className={`meth ${METHOD_CLASS[op.method] ?? ""}`}>{op.method === "DELETE" ? "DEL" : op.method}</span>
                <span className="mono">{op.path}</span>
              </button>
            ))}
          </div>
        ))}
        {model.webhooks.length > 0 && (
          <div>
            <p className="ix-group">webhooks</p>
            {model.webhooks.map((op) => (
              <button key={op.anchor} type="button" className="ix-row" onClick={() => jump(op.anchor)}>
                <span className={`meth ${METHOD_CLASS[op.method] ?? ""}`}>{op.method}</span>
                <span className="mono">{op.path}</span>
              </button>
            ))}
          </div>
        )}
        {model.channels.length > 0 && (
          <div>
            <p className="ix-group">canales</p>
            {model.channels.map((c) => (
              <button key={c.anchor} type="button" className="ix-row" onClick={() => jump(c.anchor)}>
                <span className="mono">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        {model.schemas.length > 0 && (
          <div>
            <p className="ix-group">esquemas</p>
            {model.schemas.map((s) => (
              <button key={s.anchor} type="button" className="ix-row" onClick={() => jump(s.anchor)}>
                <span className="mono">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </nav>

      <div className="contract-main">
        {stale && <p className="stale">Mostrando la última versión que se pudo leer.</p>}
        <header className="contract-head">
          <div className="title-row">
            <h2 data-testid="contract-title">{model.title}</h2>
            {model.version && <span className="ver mono">{model.version}</span>}
            {model.family && <span className="tag">{FAMILY_LABEL[model.family] ?? model.family}</span>}
            <button type="button" className="btn btn-secondary btn-sm end" onClick={() => setOpen(allOpen ? new Set() : new Set(everything))} data-testid="contract-toggle-all">
              {allOpen ? "Contraer todo" : "Expandir todo"}
            </button>
          </div>
          {model.description && <p className="desc">{model.description}</p>}
          {(model.servers.length > 0 || model.security.length > 0) && (
            <dl className="contract-facts">
              {model.servers.length > 0 && (
                <>
                  <dt>Servidores</dt>
                  <dd>
                    {model.servers.map((s) => (
                      <span key={s.url} className="srv">
                        <span className="mono">{s.url}</span>
                        {s.description && <span className="muted"> {s.description}</span>}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {model.security.length > 0 && (
                <>
                  <dt>Autenticación</dt>
                  <dd>
                    {model.security.map((s) => (
                      <span key={s.name} className="srv">
                        <span className="mono">{s.name}</span> <span className="muted">{s.type}</span>
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          )}
        </header>

        {model.groups.map((g) => (
          <section key={g.name} className="contract-group">
            <h3>
              {g.name} <span>{g.description ?? (g.operations.length === 1 ? "1 operación" : `${g.operations.length} operaciones`)}</span>
            </h3>
            {cards(g.operations)}
          </section>
        ))}
        {model.webhooks.length > 0 && (
          <section className="contract-group">
            <h3>
              webhooks <span>avisos que la API envía</span>
            </h3>
            {cards(model.webhooks)}
          </section>
        )}
        {model.channels.length > 0 && (
          <section className="contract-group">
            <h3>
              canales <span>{model.channels.length}</span>
            </h3>
            {model.channels.map((c) => (
              <ChannelCard key={c.anchor} channel={c} schemas={model.schemas} open={open.has(c.anchor)} onToggle={() => toggle(c.anchor)} active={focus === c.anchor} />
            ))}
          </section>
        )}
        {model.schemas.length > 0 && (
          <section className="contract-group">
            <h3>
              esquemas <span>{model.schemas.length === 1 ? "1 modelo" : `${model.schemas.length} modelos`}</span>
            </h3>
            {model.schemas.map((s) => (
              <ModelCard key={s.anchor} model={s} schemas={model.schemas} open={open.has(s.anchor)} onToggle={() => toggle(s.anchor)} active={focus === s.anchor} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function useScrollWhen(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "start" });
  }, [active]);
  return ref;
}

function ModelCard({ model, schemas, open, onToggle, active }: { model: Schemas[number]; schemas: Schemas; open: boolean; onToggle(): void; active: boolean }) {
  const ref = useScrollWhen(active);
  return (
    <article ref={ref} className="card model" data-testid={`contract-schema-${model.name}`}>
      <button type="button" className="card-head" aria-expanded={open} onClick={onToggle}>
        <span className="p mono">{model.name}</span>
        <span className="s">{model.schema.description ?? (model.schema.variants?.mode === "allOf" ? "object" : model.schema.type)}</span>
        <span className="chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="card-body">
          <Payload content={{ mediaType: "modelo", schema: { ...model.schema, ref: model.name }, example: null, sample: model.sample }} schemas={schemas} />
        </div>
      )}
    </article>
  );
}

function ChannelCard({ channel, schemas, open, onToggle, active }: { channel: DocModel["channels"][number]; schemas: Schemas; open: boolean; onToggle(): void; active: boolean }) {
  const ref = useScrollWhen(active);
  return (
    <article ref={ref} className="card" data-testid={`contract-channel-${channel.anchor}`}>
      <button type="button" className="card-head" aria-expanded={open} onClick={onToggle}>
        <span className="p mono">{channel.name}</span>
        <span className="s">{channel.address && channel.address !== channel.name ? channel.address : (channel.description ?? "")}</span>
        <span className="chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="card-body">
          {channel.description && (
            <div className="lead">
              <p>{channel.description}</p>
            </div>
          )}
          {channel.operations.length > 0 && (
            <>
              <h4>Operaciones</h4>
              <ul className="ch-ops">
                {channel.operations.map((o) => (
                  <li key={o.name}>
                    <span className={`badge ${METHOD_CLASS[o.action.toUpperCase()] ?? ""}`}>{o.action === "send" ? "envía" : o.action === "receive" ? "recibe" : o.action}</span>
                    <span className="mono">{o.name}</span>
                    {o.summary && <span className="muted">{o.summary}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {channel.messages.map((m) => (
            <div key={m.name}>
              <h4>
                Mensaje <span className="mono">{m.name}</span> {m.summary && <span className="muted">{m.summary}</span>}
              </h4>
              {m.payload && <Payload content={{ mediaType: "payload", schema: m.payload, example: null, sample: m.sample }} schemas={schemas} />}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
