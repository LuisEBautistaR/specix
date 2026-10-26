import { EventEmitter } from "node:events";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { CompletionResult, DocModel, DocumentAnalysis, HoverResult, LangStatus, PingResult, TextRange } from "@shared/ipc";
import type { HostParams } from "@shared/host-methods";
import { HostProcess } from "./host-process";

export interface LangServiceOptions {
  hostEntry: string;
  testMode: boolean;
  log: (message: string, detail?: unknown) => void;
}

type Events = { status: [LangStatus] };

/** Where an analysed text lives (see contextSchema). */
export type DocumentContext = NonNullable<HostParams<"lang.analyze">["context"]>;

/**
 * The language host: one utilityProcess that parses and checks documents, so a
 * huge or hostile file can slow or crash it without touching the window.
 * Started with the app and restarted by HostProcess if it dies.
 */
export class LangService extends EventEmitter<Events> {
  readonly #host: HostProcess;

  constructor(opts: LangServiceOptions) {
    super();
    this.#host = new HostProcess({
      entry: opts.hostEntry,
      serviceName: "Specix: lenguaje",
      testMode: opts.testMode,
      log: (m, d) => opts.log(`[lang] ${m}`, d),
    });
    this.#host.on("status", (s) => this.emit("status", { ...s }));
  }

  start(): void {
    this.#host.start();
  }

  get status(): LangStatus {
    return this.#host.status;
  }

  analyze(text: string, context?: DocumentContext): Promise<Outcome<DocumentAnalysis>> {
    return this.#host.call("lang.analyze", context ? { text, context } : { text });
  }

  docs(text: string, context?: DocumentContext): Promise<Outcome<DocModel | null>> {
    return this.#host.call("lang.docs", context ? { text, context } : { text }) as Promise<Outcome<DocModel | null>>;
  }

  complete(cursor: HostParams<"lang.complete">): Promise<Outcome<CompletionResult | null>> {
    return this.#host.call("lang.complete", cursor, 5_000);
  }

  hover(cursor: HostParams<"lang.hover">): Promise<Outcome<HoverResult | null>> {
    return this.#host.call("lang.hover", cursor, 5_000);
  }

  definition(cursor: HostParams<"lang.definition">): Promise<Outcome<TextRange | null>> {
    return this.#host.call("lang.definition", cursor, 5_000);
  }

  path(cursor: HostParams<"lang.path">): Promise<Outcome<string[]>> {
    return this.#host.call("lang.path", cursor, 5_000);
  }

  async ping(): Promise<Outcome<PingResult>> {
    const sentAt = performance.now();
    const outcome = await this.#host.call("system.ping", { sentAt: Date.now() }, 5_000);
    if (!outcome.ok) return outcome;
    return { ok: true, value: { roundTripMs: Math.round((performance.now() - sentAt) * 10) / 10, pid: outcome.value.pid, uptimeMs: outcome.value.uptimeMs } };
  }

  /** Test mode only: kills the host to exercise the restart path. */
  crashHost(): Promise<Outcome<{ scheduled: true }>> {
    if (this.#host.status.state !== "ready") {
      return Promise.resolve({ ok: false, error: { code: ErrorCodes.hostUnavailable, message: "The language host is not ready" } });
    }
    return this.#host.call("diagnostics.crash", { exitCode: 3 });
  }

  stop(): Promise<void> {
    return this.#host.stop();
  }
}
