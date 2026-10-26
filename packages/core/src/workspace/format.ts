/**
 * On-disk format of a Specix workspace (git-friendly, everything is plain YAML):
 *
 *   specix.workspace.yaml          name of the workspace
 *   apis/<api>/api.yaml            versions, their state and the default one
 *   apis/<api>/<version>/…         the definition (entry file plus any files it references)
 *   dominios/<dominio>/…           same layout, holding reusable components
 *   plantillas/<plantilla>/<file>  definitions new APIs start from
 *   .specix/                       local data (not meant for git)
 *
 * Nothing Specix-specific goes inside the definitions themselves.
 */
import { z } from "zod";

export const WORKSPACE_FILE = "specix.workspace.yaml";
export const API_FILE = "api.yaml";
export const APIS_DIR = "apis";
export const DOMAINS_DIR = "dominios";
export const TEMPLATES_DIR = "plantillas";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const GUIDES_DIR = "guias";

export const workspaceSchema = z.object({
  specix: z.literal(1),
  name: z.string().min(1).max(100),
  /** Style guide applied to every API, relative to the workspace root; the built-in base when absent. */
  guide: z.string().min(1).optional(),
});

export const versionSchema = z.object({
  state: z.enum(["draft", "published"]),
  /** Entry file, relative to the version folder. */
  entry: z.string().min(1).default("openapi.yaml"),
  /** sha256 of the version's files when it was published. */
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  publishedAt: z.string().optional(),
});

export const apiSchema = z.object({
  kind: z.enum(["api", "domain"]).default("api"),
  defaultVersion: z.string().regex(VERSION).optional(),
  versions: z.record(z.string().regex(VERSION), versionSchema).default({}),
});

export type WorkspaceFile = z.output<typeof workspaceSchema>;
export type ApiFile = z.output<typeof apiSchema>;
export type VersionEntry = z.output<typeof versionSchema>;

/** Compares semantic versions for sorting (pre-releases before their release). */
export function compareVersions(a: string, b: string): number {
  const [ca = "", pa] = a.split("-", 2);
  const [cb = "", pb] = b.split("-", 2);
  const na = ca.split(".").map(Number);
  const nb = cb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}
