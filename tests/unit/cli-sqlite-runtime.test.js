import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { buildEnvWithRuntime, getRuntimeNodeModules } = require("../../cli/hooks/sqliteRuntime.js");

describe("CLI SQLite runtime packaging", () => {
  it("keeps the bundled and user runtime module paths available", () => {
    const env = buildEnvWithRuntime({ NODE_PATH: "existing-path" });
    const paths = env.NODE_PATH.split(path.delimiter);

    const bundledPath = fs.existsSync(path.resolve("cli/app/_nm"))
      ? path.resolve("cli/app/_nm")
      : path.resolve("cli/app/node_modules");
    const runtimePath = getRuntimeNodeModules();
    expect(paths).toContain(bundledPath);
    expect(paths).toContain(runtimePath);
    expect(paths).toContain("existing-path");
    expect(paths.indexOf(bundledPath)).toBeLessThan(paths.indexOf(runtimePath));
  });

  it("publishes the sql.js WASM asset through the CLI allowlist", () => {
    const npmignore = fs.readFileSync(path.resolve("cli/.npmignore"), "utf8");
    expect(npmignore).toContain("!app/_nm/sql.js/**");
  });
});
