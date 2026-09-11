import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "../src/server.ts";

const root = join(import.meta.dirname, "..");

describe("version pin", () => {
  it("is past 0.1.0, bins dist/index.js, pins Node 22, and keeps the example mcp launch", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
      engines: { node: string };
      main: string;
    };
    expect(pkg.version).not.toBe("0.1.0");
    expect(pkg.version.localeCompare("0.1.0", undefined, { numeric: true })).toBeGreaterThan(0);
    expect(pkg.version).toBe(SERVER_VERSION);
    expect(pkg.bin["apple-messages-mcp"]).toBe("dist/index.js");
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.engines.node).toMatch(/22/);
    expect(pkg.engines.node).toMatch(/<23|^\s*22\s*$|\^22|22\.x/);

    const example = JSON.parse(
      readFileSync(join(root, "examples/cursor-mcp.json"), "utf8"),
    ) as { mcpServers: { "apple-messages": { command: string; args: string[] } } };
    expect(example.mcpServers["apple-messages"].command).toBe("node");
    expect(example.mcpServers["apple-messages"].args).toEqual([
      "/ABS/PATH/TO/apple-messages-mcp/dist/index.js",
    ]);
  });
});
