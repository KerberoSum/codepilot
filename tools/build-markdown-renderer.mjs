import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "frontend"), { recursive:true });
await build({
  entryPoints:[resolve(root,"tools/markdown-renderer.mjs")],
  outfile:resolve(root,"frontend/markdown-renderer.min.js"),
  bundle:true, minify:true, format:"iife", platform:"browser",
  target:["es2020"], legalComments:"eof",
  alias:{katex:"temml"}
});
copyFileSync(resolve(root,"node_modules/temml/dist/Temml-Local.css"),resolve(root,"frontend/temml.css"));
copyFileSync(resolve(root,"node_modules/temml/dist/Temml.woff2"),resolve(root,"frontend/Temml.woff2"));
console.log("Self-hosted Markdown and MathML renderer built.");
