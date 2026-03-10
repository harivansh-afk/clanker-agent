import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const sourceRoot = process.env.COMPANION_BUILTIN_EXTENSIONS_SRC
  ? path.resolve(process.env.COMPANION_BUILTIN_EXTENSIONS_SRC)
  : path.resolve(process.cwd(), "packages");
const outputRoot = process.env.COMPANION_BUILTIN_EXTENSIONS_OUT
  ? path.resolve(process.env.COMPANION_BUILTIN_EXTENSIONS_OUT)
  : path.resolve(process.cwd(), ".tmp/builtins");

const entries = [
  {
    name: "companion-channels",
    entry: path.join(sourceRoot, "companion-channels", "src", "index.ts"),
  },
  {
    name: "companion-teams",
    entry: path.join(sourceRoot, "companion-teams", "extensions", "index.ts"),
  },
  {
    name: "companion-grind",
    entry: path.join(sourceRoot, "companion-grind", "src", "index.ts"),
  },
];

const external = [
  "@mariozechner/companion-agent-core",
  "@mariozechner/companion-ai",
  "@mariozechner/companion-ai/oauth",
  "@mariozechner/companion-coding-agent",
  "@mariozechner/companion-tui",
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
