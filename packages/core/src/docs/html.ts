/**
 * Static documentation site: one self-contained HTML file per API version,
 * plus an index. No scripts, no external requests: it opens from disk, a
 * file share or any static host. Colours follow the reader's light or dark
 * preference; the brand colour marks the header and links.
 */
import { escapeHtml as esc, markdownToHtml } from "./markdown.js";
import type { DocContent, DocModel, DocOperation, DocSchema } from "./model.js";

export interface Brand {
  /** Shown in the header, e.g. the company or team. */
  name: string;
  /** Hex colour for the header bar and links, e.g. "#5c6b54". */
  color: string;
  /** Logo as a data: URL (PNG or SVG), embedded in the page. */
  logo: string | null;
}

export interface VersionLink {
  version: string;
  href: string;
  current: boolean;
  isDefault: boolean;
}

export const DEFAULT_BRAND: Brand = { name: "Documentación de APIs", color: "#5c6b54", logo: null };

export function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_BRAND.color;
}

const METHOD_COLORS: Record<string, string> = { GET: "#176a77", POST: "#8a5a0c", PUT: "#4249a6", PATCH: "#7346a0", DELETE: "#a33a2c" };

const STYLE = (brand: string) => `
:root { --brand: ${brand}; --bg: #f7f6f4; --panel: #eeecea; --line: #d5d0ca; --ink: #333231; --muted: #57534f; --code: #e4e1dd; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #242322; --panel: #2a2927; --line: #3d3a36; --ink: #e9e6e2; --muted: #b0aaa3; --code: #1d1c1b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--brand); }
@media (prefers-color-scheme: dark) { a { color: color-mix(in srgb, var(--brand) 55%, white); } }
code, pre, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
header { display: flex; align-items: center; gap: 14px; padding: 12px 24px; background: var(--brand); color: #fff; }
header img { height: 28px; }
header .brand { font-weight: 700; }
header .api { margin-left: auto; opacity: 0.9; }
header a { color: #fff; }
.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); max-width: 1280px; margin: 0 auto; }
nav { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; padding: 18px 16px; border-right: 1px solid var(--line); font-size: 13.5px; }
nav h4 { margin: 14px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
nav a { display: flex; gap: 8px; padding: 2px 0; color: var(--ink); text-decoration: none; }
nav a:hover { text-decoration: underline; }
nav .versions a.current { font-weight: 700; }
main { padding: 24px 32px 64px; min-width: 0; }
h1 { margin: 0 0 4px; font-size: 26px; }
h2 { margin: 36px 0 10px; font-size: 20px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { margin: 0; font-size: 16px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.sub { color: var(--muted); margin: 0 0 12px; }
.op { margin: 16px 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 14px 16px; }
.method { font: 700 12px ui-monospace, Consolas, monospace; padding: 2px 6px; border-radius: 4px; color: #fff; }
.path { font: 600 14px ui-monospace, Consolas, monospace; word-break: break-all; }
.dep { color: #a33a2c; font-size: 12px; font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13.5px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12.5px; }
.req { font-size: 11px; font-weight: 700; border: 1px solid var(--muted); border-radius: 3px; padding: 0 4px; margin-left: 6px; }
.type { color: var(--brand); }
@media (prefers-color-scheme: dark) { .type { color: color-mix(in srgb, var(--brand) 55%, white); } }
.muted { color: var(--muted); }
pre { background: var(--code); padding: 10px 12px; border-radius: 4px; overflow: auto; }
.schema { margin: 6px 0 6px 0; padding-left: 12px; border-left: 2px solid var(--line); }
.code-ok { color: #2d6844; font-weight: 700; } .code-err { color: #a1362a; font-weight: 700; }
@media (prefers-color-scheme: dark) { .code-ok { color: #8fcaa0; } .code-err { color: #f09385; } }
.md h4 { font-size: 16px; margin: 18px 0 6px; } .md h5 { font-size: 15px; margin: 14px 0 4px; } .md h6 { font-size: 14px; margin: 12px 0 4px; }
.server .desc { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px; }
footer { padding: 20px 32px; color: var(--muted); font-size: 12.5px; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } nav { position: static; max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 16px; } }
`;

const md = (text: string | null) => (text ? `<div class="md">${markdownToHtml(text)}</div>` : "");
const method = (m: string) => `<span class="method" style="background:${METHOD_COLORS[m] ?? "#57534f"}">${esc(m)}</span>`;

function schemaHtml(s: DocSchema | null, depth = 0): string {
  if (!s) return "";
  const label = s.ref && depth > 0 ? s.ref : s.ref ? `${s.ref} · ${s.type}` : s.type;
  const head = `<span class="type mono">${esc(label)}</span>${s.enum.length ? ` <span class="muted">· ${s.enum.map((v) => `<code>${esc(v)}</code>`).join(" · ")}</span>` : ""}${s.constraints.length ? ` <span class="muted">· ${esc(s.constraints.join(" · "))}</span>` : ""}`;
  const parts = [head];
  if (s.properties.length && depth < 4) {
    parts.push(
      `<table><tr><th>Propiedad</th><th>Tipo</th><th>Descripción</th></tr>${s.properties
        .map(
          (p) =>
            `<tr><td class="mono">${esc(p.name)}${p.required ? '<span class="req">oblig.</span>' : ""}</td><td>${schemaHtml({ ...p.schema, properties: [], description: null }, depth + 1)}</td><td>${p.schema.description ? esc(p.schema.description) : ""}${p.schema.properties.length ? `<div class="schema">${schemaHtml({ ...p.schema, description: null }, depth + 1)}</div>` : ""}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  if (s.items && s.items.properties.length && depth < 4) parts.push(`<div class="schema">${schemaHtml(s.items, depth + 1)}</div>`);
  if (s.variants) parts.push(`<div class="schema"><span class="muted">${esc(s.variants.mode)}:</span> ${s.variants.options.map((o) => schemaHtml(o, depth + 1)).join(" <span class=\"muted\">|</span> ")}</div>`);
  return parts.join("");
}

function contentsHtml(contents: DocContent[]): string {
  return contents
    .map((c) => `<p class="muted mono">${esc(c.mediaType)}</p>${schemaHtml(c.schema)}${c.example ? `<pre>${esc(c.example)}</pre>` : ""}`)
    .join("");
}

function operationHtml(op: DocOperation): string {
  const params = op.parameters.length
    ? `<h4>Parámetros</h4><table><tr><th>Nombre</th><th>En</th><th>Tipo</th><th>Descripción</th></tr>${op.parameters
        .map((p) => `<tr><td class="mono">${esc(p.name)}${p.required ? '<span class="req">oblig.</span>' : ""}</td><td>${esc(p.in)}</td><td>${schemaHtml(p.schema)}</td><td>${p.description ? esc(p.description) : ""}</td></tr>`)
        .join("")}</table>`
    : "";
  const body = op.requestBody ? `<h4>Cuerpo${op.requestBody.required ? ' <span class="req">oblig.</span>' : ""}</h4>${md(op.requestBody.description)}${contentsHtml(op.requestBody.contents)}` : "";
  const responses = op.responses.length
    ? `<h4>Respuestas</h4>${op.responses
        .map((r) => `<div><span class="${/^[23]/.test(r.code) ? "code-ok" : "code-err"} mono">${esc(r.code)}</span> ${esc(r.description)}${r.headers.length ? ` <span class="muted">· cabeceras: ${esc(r.headers.join(", "))}</span>` : ""}${contentsHtml(r.contents)}</div>`)
        .join("")}`
    : "";
  return `<section class="op" id="${op.anchor}"><h3>${method(op.method)}<span class="path">${esc(op.path)}</span>${op.deprecated ? '<span class="dep">obsoleta</span>' : ""}</h3>${op.summary ? `<p><strong>${esc(op.summary)}</strong></p>` : ""}${md(op.description)}${op.operationId ? `<p class="muted">operationId <code>${esc(op.operationId)}</code>${op.security.length ? ` · seguridad: ${esc(op.security.join(", "))}` : ""}</p>` : ""}${params}${body}${responses}</section>`;
}

function page(title: string, brand: Brand, nav: string, main: string, headerRight: string): string {
  const logo = brand.logo && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(brand.logo) ? `<img src="${brand.logo}" alt="">` : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>${STYLE(safeColor(brand.color))}</style>
</head>
<body>
<header>${logo}<span class="brand">${esc(brand.name)}</span><span class="api">${headerRight}</span></header>
<div class="layout"><nav>${nav}</nav><main>${main}</main></div>
<footer>Generado con Specix.</footer>
</body>
</html>
`;
}

/** The page of one API version. */
export function renderDocsPage(model: DocModel, options: { brand?: Brand; versions?: VersionLink[]; indexHref?: string | null } = {}): string {
  const brand = options.brand ?? DEFAULT_BRAND;
  const versions = options.versions ?? [];
  const nav = [
    options.indexHref ? `<a href="${esc(options.indexHref)}">← Todas las APIs</a>` : "",
    versions.length
      ? `<h4>Versiones</h4><div class="versions">${versions.map((v) => `<a href="${esc(v.href)}" class="${v.current ? "current" : ""}">${esc(v.version)}${v.isDefault ? " · por defecto" : ""}</a>`).join("")}</div>`
      : "",
    ...model.groups.map((g) => `<h4>${esc(g.name)}</h4>${g.operations.map((op) => `<a href="#${op.anchor}">${method(op.method)}<span class="mono">${esc(op.path)}</span></a>`).join("")}`),
    model.webhooks.length ? `<h4>Webhooks</h4>${model.webhooks.map((op) => `<a href="#${op.anchor}">${method(op.method)}<span class="mono">${esc(op.path)}</span></a>`).join("")}` : "",
    model.channels.length ? `<h4>Canales</h4>${model.channels.map((c) => `<a href="#${c.anchor}" class="mono">${esc(c.name)}</a>`).join("")}` : "",
    model.schemas.length ? `<h4>Esquemas</h4>${model.schemas.map((s) => `<a href="#${s.anchor}" class="mono">${esc(s.name)}</a>`).join("")}` : "",
  ].join("");
  const main = [
    `<h1>${esc(model.title)}</h1>`,
    `<p class="sub">${model.version ? `Versión ${esc(model.version)} · ` : ""}${model.operationCount} ${model.operationCount === 1 ? "operación" : "operaciones"}</p>`,
    md(model.description),
    model.servers.length ? `<h4>Servidores</h4>${model.servers.map((s) => `<p class="server"><span class="mono">${esc(s.url)}</span>${s.description ? ` <span class="muted desc">· ${esc(s.description)}</span>` : ""}</p>`).join("")}` : "",
    model.security.length ? `<h4>Autenticación</h4><table>${model.security.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td>${esc(s.type)}</td><td>${s.description ? esc(s.description) : ""}</td></tr>`).join("")}</table>` : "",
    ...model.groups.map((g) => `<h2>${esc(g.name)}</h2>${md(g.description)}${g.operations.map(operationHtml).join("")}`),
    model.webhooks.length ? `<h2>Webhooks</h2>${model.webhooks.map(operationHtml).join("")}` : "",
    model.channels.length
      ? `<h2>Canales</h2>${model.channels
          .map(
            (c) =>
              `<section class="op" id="${c.anchor}"><h3><span class="path">${esc(c.name)}</span>${c.address && c.address !== c.name ? `<span class="muted mono">${esc(c.address)}</span>` : ""}</h3>${md(c.description)}${c.operations.map((o) => `<p>${method(o.action.toUpperCase())} <code>${esc(o.name)}</code>${o.summary ? ` · ${esc(o.summary)}` : ""}</p>`).join("")}${c.messages.map((m) => `<h4>Mensaje ${esc(m.name)}</h4>${m.summary ? `<p>${esc(m.summary)}</p>` : ""}${schemaHtml(m.payload)}`).join("")}</section>`,
          )
          .join("")}`
      : "",
    model.schemas.length ? `<h2>Esquemas</h2>${model.schemas.map((s) => `<section class="op" id="${s.anchor}"><h3><span class="path">${esc(s.name)}</span></h3>${md(s.schema.description)}${schemaHtml(s.schema)}</section>`).join("")}` : "",
  ].join("\n");
  return page(`${model.title}${model.version ? ` ${model.version}` : ""}`, brand, nav, main, `${esc(model.title)}${model.version ? ` <span class="mono">${esc(model.version)}</span>` : ""}`);
}

export interface IndexEntry {
  name: string;
  title: string;
  description: string | null;
  versions: Array<{ version: string; href: string; isDefault: boolean; published: boolean }>;
}

/** The front page listing every API and its versions. */
export function renderDocsIndex(workspaceName: string, entries: IndexEntry[], brand: Brand = DEFAULT_BRAND): string {
  const main = [
    `<h1>${esc(workspaceName)}</h1>`,
    `<p class="sub">${entries.length} ${entries.length === 1 ? "API" : "APIs"}</p>`,
    ...entries.map(
      (e) =>
        `<section class="op"><h3><span class="path">${esc(e.title)}</span><span class="muted mono">${esc(e.name)}</span></h3>${md(e.description)}<p>${e.versions
          .map((v) => `<a href="${esc(v.href)}" class="mono">${esc(v.version)}</a>${v.isDefault ? " (por defecto)" : ""}${v.published ? "" : ' <span class="muted">borrador</span>'}`)
          .join(" · ")}</p></section>`,
    ),
  ].join("\n");
  const nav = `<h4>APIs</h4>${entries.map((e) => `<a href="${esc(e.versions.find((v) => v.isDefault)?.href ?? e.versions.at(-1)?.href ?? "#")}">${esc(e.title)}</a>`).join("")}`;
  return page(workspaceName, brand, nav, main, esc(workspaceName));
}
