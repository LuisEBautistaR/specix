/// <reference types="electron" />
/**
 * Language host entry point. Runs in an Electron utilityProcess forked by main:
 * no window, no Electron main APIs, never sees the renderer. Main hands it a
 * MessagePort in the first message; every call arrives through it.
 */
import { handshakeSchema, type FromHost } from "@shared/rpc";
import { createHandlers } from "./handlers";
import { createRpcServer } from "./rpc-server";

const log = (message: string, detail?: unknown): void => {
  if (detail === undefined) console.log(`[host] ${message}`);
  else console.error(`[host] ${message}`, detail);
};

const parentPort = process.parentPort;
if (!parentPort) {
  console.error("[host] Must run as an Electron utilityProcess");
  process.exit(1);
}

parentPort.once("message", ({ data, ports }) => {
  const handshake = handshakeSchema.safeParse(data);
  const port = ports[0];
  if (!handshake.success || !port) {
    log("Invalid handshake from main", handshake.success ? "missing port" : handshake.error.issues);
    process.exit(2);
  }
  const { testMode } = handshake.data;
  const send = (message: FromHost): void => port.postMessage(message);

  const handlers = createHandlers({ exit: (code) => process.exit(code) });
  const server = createRpcServer({ handlers, send, testMode, log });

  port.on("message", ({ data: message }) => server.handle(message));
  port.on("close", () => {
    log("Port closed by main, exiting");
    process.exit(0);
  });
  port.start();

  send({ kind: "event", stream: "host", name: "ready", data: { pid: process.pid } });
  log(`Ready (pid ${process.pid})`);
});
