import { useMemo, useState } from "react";
import type { Diagnostic, DocumentAnalysis, GuideRuleView } from "@shared/ipc";

const SEVERITY_WORD: Record<GuideRuleView["severity"], { word: string; cls: string }> = {
  error: { word: "Error", cls: "e" },
  warning: { word: "Aviso", cls: "w" },
  info: { word: "Info", cls: "i" },
  hint: { word: "Pista", cls: "h" },
  off: { word: "Apagada", cls: "h" },
};

interface Props {
  analysis: DocumentAnalysis | null;
  /** The workspace's guide file (relative), null for the built-in base, undefined without a workspace. */
  guideFile: string | null | undefined;
  /** Why no guide applies to the open file, when that is the case. */
  fileRole: "api" | "domain" | "fragment" | "guide";
  onOpenGuide: (() => void) | null;
  onReveal: (d: Diagnostic) => void;
}

/** The style guide that applies to the open definition: its rules and what fails in this document. */
export function GovernancePanel({ analysis, guideFile, fileRole, onOpenGuide, onReveal }: Props) {
  const [onlyFailing, setOnlyFailing] = useState(false);
  const guide = analysis?.guide ?? null;
  const failures = useMemo(() => {
    const byRule = new Map<string, Diagnostic[]>();
    for (const d of analysis?.diagnostics ?? []) {
      if (d.source !== "guía") continue;
      const name = d.code.replace(/^guia\//, "");
      byRule.set(name, [...(byRule.get(name) ?? []), d]);
    }
    return byRule;
  }, [analysis]);

  const guideName = guideFile ?? "specix:base";
  const head = (
    <>
      <h2 className="section-label">
        Guía de estilo <span>compatible con Spectral</span>
        {onOpenGuide && (
          <span className="end">
            <button type="button" className="link-btn" onClick={onOpenGuide} data-testid="open-guide">
              Abrir {guideFile}
            </button>
          </span>
        )}
      </h2>
      <dl className="facts">
        <dt>Guía</dt>
        <dd className="mono" data-testid="guide-name">
          {guideName}
          {guideFile === null && <span className="muted"> · incluida en Specix</span>}
        </dd>
        {guide && (
          <>
            <dt>Reglas</dt>
            <dd className="mono" data-testid="guide-rules">
              {guide.rulesRun} de {guide.rules.length} aplican a esta especificación
            </dd>
            <dt>Fallos aquí</dt>
            <dd className="mono" data-testid="guide-failures">
              {[...failures.values()].reduce((n, list) => n + list.length, 0)}
            </dd>
          </>
        )}
      </dl>
    </>
  );

  if (!guide) {
    const why =
      fileRole === "guide"
        ? "Este archivo es una guía: se revisa su formato (funciones, severidades y formatos conocidos). Guárdala y las APIs la aplican al momento."
        : fileRole === "domain"
          ? "Los dominios solo guardan componentes compartidos; la guía se aplica a las APIs que los usan."
          : fileRole === "fragment"
            ? "Este archivo es un fragmento: la guía se aplica a la entrada de la versión, con los fragmentos que referencia."
            : "La guía se aplica cuando el documento se puede leer.";
    return (
      <div data-testid="governance">
        {head}
        <p className="note pad-top">{why}</p>
      </div>
    );
  }

  const rules = onlyFailing ? guide.rules.filter((r) => failures.has(r.name)) : guide.rules;
  return (
    <div data-testid="governance">
      {head}
      {guide.problems.length > 0 && (
        <ul className="guide-problems" data-testid="guide-problems">
          {guide.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <h2 className="section-label">
        Reglas <span className="mono">{guide.rules.length}</span>
        <span className="end segctl" role="group" aria-label="Qué reglas mostrar">
          <button type="button" aria-pressed={!onlyFailing} onClick={() => setOnlyFailing(false)}>
            Todas
          </button>
          <button type="button" aria-pressed={onlyFailing} onClick={() => setOnlyFailing(true)} data-testid="rules-failing">
            Con fallos
          </button>
        </span>
      </h2>
      <table className="rules" data-testid="rules">
        <colgroup>
          <col />
          <col style={{ width: 72 }} />
          <col style={{ width: "34%" }} />
          <col style={{ width: 52 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Regla</th>
            <th>Severidad</th>
            <th>Aplica a</th>
            <th className="r">Fallos</th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Ninguna regla falla en este documento.
              </td>
            </tr>
          )}
          {rules.map((rule) => {
            const failed = failures.get(rule.name) ?? [];
            const first = failed[0];
            return (
              <tr key={rule.name} className={rule.applies ? undefined : "off"} data-testid="rule" data-rule={rule.name}>
                <td>
                  <span className="mono rule-name">{rule.name}</span>
                  {rule.description && <span className="rule-desc">{rule.description}</span>}
                  {rule.origin !== guideName && <span className="rule-desc mono">de {rule.origin}</span>}
                </td>
                <td className={`sev ${SEVERITY_WORD[rule.severity].cls}`}>{rule.applies ? SEVERITY_WORD[rule.severity].word : "No aplica"}</td>
                <td className="mono small" title={rule.given.join("\n")}>
                  <span className="given">
                    {rule.given[0]}
                    {rule.given.length > 1 && <span className="muted"> +{rule.given.length - 1}</span>}
                  </span>
                  <span className="muted">{rule.functions.join(", ")}</span>
                </td>
                <td className="r">
                  {first ? (
                    <button type="button" className={`link-btn hits ${first.severity === "error" ? "err-t" : ""}`} onClick={() => onReveal(first)} title={`Ir a la línea ${first.range.start.line}`}>
                      {failed.length}
                    </button>
                  ) : (
                    <span className="hits muted">{rule.applies ? 0 : "—"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note pad-top">
        En CI: <code className="mono">specix lint . --formato sarif</code> aplica esta misma guía.
      </p>
    </div>
  );
}
