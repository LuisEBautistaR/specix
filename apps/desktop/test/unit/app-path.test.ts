import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isAppUrl, resolveAppPath } from "../../src/main/app-path";
import { isHostMethod } from "@shared/host-methods";

const root = join("C:", "app", "renderer");

describe("resolveAppPath", () => {
  it("maps the root and files inside the renderer folder", () => {
    expect(resolveAppPath(root, "app://specix/")).toBe(join(root, "index.html"));
    expect(resolveAppPath(root, "app://specix/assets/index.js")).toBe(join(root, "assets", "index.js"));
    expect(resolveAppPath(root, "app://specix/assets/caf%C3%A9.css")).toBe(join(root, "assets", "café.css"));
  });

  it("keeps dot segments inside the folder (the URL parser collapses them)", () => {
    for (const url of ["app://specix/../secrets.txt", "app://specix/%2e%2e/secrets.txt", "app://specix/assets/%2e%2e/%2e%2e/secrets.txt"]) {
      expect(resolveAppPath(root, url), url).toBe(join(root, "secrets.txt"));
    }
  });

  it("refuses paths that escape the folder", () => {
    for (const url of [
      "app://specix/..%5c..%5csecrets.txt",
      "app://specix/assets%5c..%5c..%5c..%5cwindows%5cwin.ini",
      "app://specix/%00index.html",
      "app://specix/%E0%A4%A",
    ]) {
      expect(resolveAppPath(root, url), url).toBeNull();
    }
  });

  it("refuses other hosts and schemes", () => {
    expect(resolveAppPath(root, "app://other/index.html")).toBeNull();
    expect(resolveAppPath(root, "file:///C:/app/renderer/index.html")).toBeNull();
    expect(resolveAppPath(root, "not a url")).toBeNull();
  });
});

describe("isAppUrl", () => {
  it("accepts only the app origin", () => {
    expect(isAppUrl("app://specix/index.html")).toBe(true);
    expect(isAppUrl("https://specix/index.html")).toBe(false);
    expect(isAppUrl("app://specix.evil/index.html")).toBe(false);
  });
});

describe("isHostMethod", () => {
  it("does not treat inherited object keys as methods", () => {
    expect(isHostMethod("lang.analyze")).toBe(true);
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", 42, null]) {
      expect(isHostMethod(name)).toBe(false);
    }
  });
});
