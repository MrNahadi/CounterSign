import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Next's CSS worker exits before connecting under Turbopack on this Windows/Node setup.
// Keep the existing Linux/Render build and use Next's supported Webpack option on Windows.
const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    "build",
    ...(process.platform === "win32" ? ["--webpack"] : []),
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  },
);
child.once("error", () => {
  console.error("The Next build process could not start.");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
