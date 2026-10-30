import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PREFS, type Prefs } from "@shared/prefs";

/**
 * Preferences of this computer: read once, then kept in step with main.
 * `loaded` stays false until main answers, so startup choices wait for the real values.
 */
export function usePrefs(): { prefs: Prefs; loaded: boolean; save: (update: (p: Prefs) => Prefs) => void } {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const current = useRef(prefs);
  current.current = prefs;

  useEffect(() => {
    const off = window.specix.prefs.onChanged(setPrefs);
    void window.specix.prefs.get().then((p) => {
      if (p) setPrefs(p);
      setLoaded(true);
    });
    return off;
  }, []);

  const save = useCallback((update: (p: Prefs) => Prefs) => {
    const next = update(current.current);
    // Shown at once; main stores it and sends it back to every window.
    setPrefs(next);
    void window.specix.prefs.set(next).then((outcome) => {
      if (!outcome.ok) void window.specix.prefs.get().then((p) => p && setPrefs(p));
    });
  }, []);

  return { prefs, loaded, save };
}
