/**
 * Writes the documentation site of a workspace:
 *   <out>/index.html                      every API and its versions
 *   <out>/<api>/<version>/index.html      one page per version (multi-file versions are bundled first)
 *   <out>/<api>/index.html                redirect-free copy of the default (or latest) version
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bundle, fsReader } from "../refs.js";
import { loadDocument } from "../source.js";
import { writeAtomic, type ApiInfo, type Workspace } from "../workspace/workspace.js";
import { DEFAULT_BRAND, renderDocsIndex, renderDocsPage, type Brand, type IndexEntry } from "./html.js";
import { docModel, type DocModel } from "./model.js";

export interface ExportResult {
  outDir: string;
  /** Written files, relative to outDir. */
  pages: string[];
  problems: Array<{ file: string; message: string }>;
}

/** Documentation model of a workspace file, bundling it with the files it references. */
export async function modelOfFile(root: string, entry: string): Promise<{ model: DocModel | null; problems: string[] }> {
  const reader = fsReader(root);
  const result = bundle(resolve(root, entry), reader);
  if (result.document !== null) return { model: docModel(result.document), problems: result.problems.map((p) => p.message) };
  // Not even the entry parses: nothing to document.
  const doc = loadDocument(await readFile(resolve(root, entry), "utf8").catch(() => ""));
  return { model: doc.value === undefined ? null : docModel(doc.value), problems: result.problems.map((p) => p.message) };
}

export async function exportWorkspaceDocs(ws: Workspace, outDir: string, options: { brand?: Brand; includeDrafts?: boolean } = {}): Promise<ExportResult> {
  const brand = options.brand ?? { ...DEFAULT_BRAND, name: ws.name };
  const out = resolve(outDir);
  const pages: string[] = [];
  const problems: ExportResult["problems"] = [];
  const entries: IndexEntry[] = [];

  const apis: ApiInfo[] = [...ws.apis, ...ws.domains];
  for (const api of apis) {
    const versions = api.versions.filter((v) => options.includeDrafts !== false || v.state === "published");
    if (versions.length === 0) continue;
    const main = versions.find((v) => v.isDefault) ?? versions.at(-1)!;
    let title = api.name;
    let description: string | null = null;
    for (const v of versions) {
      const { model, problems: found } = await modelOfFile(ws.root, v.entry);
      for (const message of found) problems.push({ file: v.entry, message });
      if (!model) {
        problems.push({ file: v.entry, message: "No se pudo leer: no hay página para esta versión" });
        continue;
      }
      if (v === main) {
        title = model.title;
        description = model.description;
      }
      const links = versions.map((other) => ({ version: other.version, href: `../${other.version}/index.html`, current: other === v, isDefault: other.isDefault }));
      const html = renderDocsPage(model, { brand, versions: links, indexHref: "../../index.html" });
      await writeAtomic(join(out, api.name, v.version, "index.html"), html);
      pages.push(`${api.name}/${v.version}/index.html`);
      if (v === main) {
        const mainLinks = versions.map((other) => ({ version: other.version, href: `${other.version}/index.html`, current: other === v, isDefault: other.isDefault }));
        await writeAtomic(join(out, api.name, "index.html"), renderDocsPage(model, { brand, versions: mainLinks, indexHref: "../index.html" }));
        pages.push(`${api.name}/index.html`);
      }
    }
    entries.push({
      name: api.name,
      title,
      description,
      versions: versions.map((v) => ({ version: v.version, href: `${api.name}/${v.version}/index.html`, isDefault: v.isDefault, published: v.state === "published" })),
    });
  }
  await writeAtomic(join(out, "index.html"), renderDocsIndex(ws.name, entries, brand));
  pages.unshift("index.html");
  return { outDir: out, pages, problems };
}
