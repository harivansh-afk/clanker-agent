import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const sourceRoot = process.env.CLANKER_BUILTIN_EXTENSIONS_SRC
  ? path.resolve(process.env.CLANKER_BUILTIN_EXTENSIONS_SRC)
  : path.resolve(process.cwd(), "packages");
const outputRoot = process.env.CLANKER_BUILTIN_EXTENSIONS_OUT
  ? path.resolve(process.env.CLANKER_BUILTIN_EXTENSIONS_OUT)
  : path.resolve(process.cwd(), ".tmp/builtins");

const entries = [
  {
    name: "clanker-channels",
    entry: path.join(sourceRoot, "clanker-channels", "src", "index.ts"),
  },
  {
    name: "clanker-teams",
    entry: path.join(sourceRoot, "clanker-teams", "extensions", "index.ts"),
  },
  {
    name: "clanker-grind",
    entry: path.join(sourceRoot, "clanker-grind", "src", "index.ts"),
  },
];

const external = [
  "@harivansh-afk/clanker-agent-core",
  "@harivansh-afk/clanker-ai",
  "@harivansh-afk/clanker-ai/oauth",
  "@harivansh-afk/clanker-coding-agent",
  "@harivansh-afk/clanker-tui",
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
