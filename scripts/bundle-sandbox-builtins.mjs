import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const sourceRoot = process.env.PI_BUILTIN_EXTENSIONS_SRC
  ? path.resolve(process.env.PI_BUILTIN_EXTENSIONS_SRC)
  : path.resolve(process.cwd(), "packages");
const outputRoot = process.env.PI_BUILTIN_EXTENSIONS_OUT
  ? path.resolve(process.env.PI_BUILTIN_EXTENSIONS_OUT)
  : path.resolve(process.cwd(), ".tmp/builtins");

const entries = [
  {
    name: "pi-channels",
    entry: path.join(sourceRoot, "pi-channels", "src", "index.ts"),
  },
  {
    name: "pi-teams",
    entry: path.join(sourceRoot, "pi-teams", "extensions", "index.ts"),
  },
  {
    name: "pi-grind",
    entry: path.join(sourceRoot, "pi-grind", "src", "index.ts"),
  },
];

const external = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
];

await mkdir(outputRoot, { recursive: true });

for (const { name, entry } of entries) {
  const outdir = path.join(outputRoot, name);
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: path.join(outdir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    logLevel: "info",
    external,
  });
  console.log(`Bundled ${name} -> ${path.join(outdir, "index.js")}`);
}
