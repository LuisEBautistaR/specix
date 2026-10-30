import { z } from "zod";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Preferences of this computer, kept in userData/settings.json. Workspace settings live in specix.workspace.yaml. */
export const prefsSchema = z.object({
  /** system follows Windows; light and dark pin the whole app, native title bar included. */
  theme: z.enum(THEMES),
  editor: z.object({
    fontSize: z.number().int().min(11).max(20),
    tabSize: z.union([z.literal(2), z.literal(4)]),
    closeBrackets: z.boolean(),
    lineWrap: z.boolean(),
  }),
  reading: z.object({
    /** What the main area shows when the app starts. */
    startView: z.enum(["codigo", "contrato"]),
    /** How bodies and responses open in the contract and the preview. */
    payloadView: z.enum(["ejemplo", "esquema"]),
  }),
  docs: z.object({
    /** Empty: the workspace name (or the API title without a workspace). */
    brand: z.string().max(100),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    includeDrafts: z.boolean(),
  }),
  startup: z.object({
    reopenWorkspace: z.boolean(),
    checkUpdates: z.boolean(),
  }),
});
export type Prefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  editor: { fontSize: 12, tabSize: 2, closeBrackets: true, lineWrap: false },
  reading: { startView: "codigo", payloadView: "ejemplo" },
  docs: { brand: "", color: "#5c6b54", includeDrafts: true },
  startup: { reopenWorkspace: true, checkUpdates: true },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads stored preferences field by field: anything missing or invalid falls back to its default. */
export function readPrefs(raw: unknown): Prefs {
  const out = structuredClone(DEFAULT_PREFS);
  if (!isRecord(raw)) return out;
  const theme = prefsSchema.shape.theme.safeParse(raw["theme"]);
  if (theme.success) out.theme = theme.data;
  for (const group of ["editor", "reading", "docs", "startup"] as const) {
    const stored = raw[group];
    if (!isRecord(stored)) continue;
    const shape = prefsSchema.shape[group].shape as Record<string, z.ZodType>;
    const target = out[group] as Record<string, unknown>;
    for (const [key, schema] of Object.entries(shape)) {
      const value = schema.safeParse(stored[key]);
      if (value.success) target[key] = value.data;
    }
  }
  return out;
}
