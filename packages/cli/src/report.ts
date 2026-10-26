/**
 * Machine-readable lint reports for CI: SARIF 2.1.0 (code scanning) and
 * JUnit XML (test report viewers). Both carry the same findings as the text output.
 */
import type { Analysis, Severity } from "@specix/core";

export interface LintFile {
  file: string;
  analysis: Analysis | null;
}

export interface LintNote {
  file: string;
  severity: Severity;
  message: string;
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note", hint: "note" };
/** Rule id for problems that belong to the workspace rather than to a line. */
const WORKSPACE_RULE = "espacio";

const uriOf = (file: string) => file.split("\\").join("/").replace(/^\.\//, "");

export function toSarif(files: LintFile[], notes: LintNote[], version: string): object {
  const rules = new Map<string, string>();
  const results: object[] = [];
  for (const { file, analysis } of files) {
    for (const d of analysis?.diagnostics ?? []) {
      if (!rules.has(d.code)) rules.set(d.code, d.source);
      results.push({
        ruleId: d.code,
        level: SARIF_LEVEL[d.severity],
        message: { text: d.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: uriOf(file) },
              region: { startLine: d.range.start.line, startColumn: d.range.start.column, endLine: d.range.end.line, endColumn: d.range.end.column },
            },
          },
        ],
      });
    }
  }
  if (notes.length) rules.set(WORKSPACE_RULE, "espacio de trabajo");
  for (const n of notes) {
    results.push({ ruleId: WORKSPACE_RULE, level: SARIF_LEVEL[n.severity], message: { text: n.message }, locations: [{ physicalLocation: { artifactLocation: { uri: uriOf(n.file) } } }] });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Specix",
            version,
            rules: [...rules].map(([id, source]) => ({ id, shortDescription: { text: `${id} (${source})` } })),
          },
        },
        results,
      },
    ],
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One suite per file; each error or warning is a failed test case, a clean file a passing one. */
export function toJunit(files: LintFile[], notes: LintNote[]): string {
  const failing = (s: Severity) => s === "error" || s === "warning";
  const suites: string[] = [];
  let total = 0;
  let failures = 0;
  const suite = (name: string, cases: string[], failed: number) => {
    const count = Math.max(cases.length, 1);
    total += count;
    failures += failed;
    const body = cases.length ? cases.join("\n") : `    <testcase classname="${xml(name)}" name="sin problemas"/>`;
    suites.push(`  <testsuite name="${xml(name)}" tests="${count}" failures="${failed}" errors="0">\n${body}\n  </testsuite>`);
  };
  for (const { file, analysis } of files) {
    if (!analysis) {
      total++;
      failures++;
      suites.push(`  <testsuite name="${xml(file)}" tests="1" failures="1" errors="0">\n    <testcase classname="${xml(file)}" name="lectura"><failure type="error" message="No se pudo leer el archivo"/></testcase>\n  </testsuite>`);
      continue;
    }
    const cases = analysis.diagnostics.filter((d) => failing(d.severity)).map((d) => {
      const where = `${file}:${d.range.start.line}:${d.range.start.column}`;
      return `    <testcase classname="${xml(file)}" name="${xml(`${d.code} ${d.range.start.line}:${d.range.start.column}`)}"><failure type="${d.severity}" message="${xml(d.message)}">${xml(`${where} ${d.message}`)}</failure></testcase>`;
    });
    suite(file, cases, cases.length);
  }
  const noteCases = notes.filter((n) => failing(n.severity)).map((n) => `    <testcase classname="${xml(n.file)}" name="${WORKSPACE_RULE}"><failure type="${n.severity}" message="${xml(n.message)}">${xml(`${n.file} ${n.message}`)}</failure></testcase>`);
  if (noteCases.length) suite("espacio de trabajo", noteCases, noteCases.length);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="specix" tests="${total}" failures="${failures}">\n${suites.join("\n")}\n</testsuites>`;
}
