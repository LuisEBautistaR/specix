import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readPrefs, type Prefs } from "@shared/prefs";

const settingsSchema = z.object({
  lastWorkspace: z.string().optional(),
});
export type Settings = z.infer<typeof settingsSchema> & { prefs: Prefs };

/** App settings in userData/settings.json. A broken file is ignored, never fatal. */
export class SettingsStore {
  readonly #file: string;
  #value: Settings = { prefs: readPrefs(undefined) };

  constructor(userDataDir: string) {
    this.#file = join(userDataDir, "settings.json");
  }

  get data(): Settings {
    return this.#value;
  }

  async load(): Promise<Settings> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      const parsed = settingsSchema.safeParse(raw);
      // Preferences are read one by one: a bad value only loses itself.
      const prefs = readPrefs(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["prefs"] : undefined);
      this.#value = { ...(parsed.success ? parsed.data : {}), prefs };
    } catch {
      this.#value = { prefs: readPrefs(undefined) };
    }
    return { ...this.#value };
  }

  async update(patch: Partial<Settings>): Promise<void> {
    this.#value = { ...this.#value, ...patch };
    // Atomic write: a crash mid-write leaves the previous file intact.
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#value, null, 2));
    await rename(tmp, this.#file);
  }
}
