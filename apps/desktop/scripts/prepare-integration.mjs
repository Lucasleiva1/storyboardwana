import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "release" ? "release" : "debug";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const resourcesRoot = join(desktopRoot, "src-tauri", "resources");
const extensionResource = join(resourcesRoot, "extension");
const extensionOutput = join(
  repositoryRoot,
  "apps",
  "extension",
  ".output",
  "chrome-mv3",
);
const nativeHost = join(
  repositoryRoot,
  "target",
  mode,
  "framesync-native-host.exe",
);
const nativeHostResource = join(resourcesRoot, "framesync-native-host.exe");
const pnpmEntry = join(
  process.env.APPDATA ?? "",
  "npm",
  "node_modules",
  "pnpm",
  "bin",
  "pnpm.mjs",
);

function run(file, args) {
  execFileSync(file, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
}

function assertInsideResources(path) {
  const resolved = resolve(path);
  const root = `${resolve(resourcesRoot)}\\`;
  if (!resolved.startsWith(root)) {
    throw new Error(`Unsafe integration resource path: ${resolved}`);
  }
}

run("cargo.exe", [
  "build",
  ...(mode === "release" ? ["--release"] : []),
  "--manifest-path",
  "crates/native-host/Cargo.toml",
]);
run(process.execPath, [pnpmEntry, "--filter", "@framesync/extension", "build"]);

if (!existsSync(nativeHost)) {
  throw new Error(`Native host build is missing: ${nativeHost}`);
}
if (!existsSync(join(extensionOutput, "manifest.json"))) {
  throw new Error(`Extension build is missing: ${extensionOutput}`);
}

mkdirSync(resourcesRoot, { recursive: true });
assertInsideResources(extensionResource);
rmSync(extensionResource, { recursive: true, force: true });
cpSync(extensionOutput, extensionResource, { recursive: true });
cpSync(nativeHost, nativeHostResource);

console.log(
  `FrameSync integration prepared (${mode}): native host + Chrome extension.`,
);
