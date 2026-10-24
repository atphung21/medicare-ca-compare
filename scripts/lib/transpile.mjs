// Transpiles app modules from src/ so plain Node scripts can import them. "@/..." imports are rewritten to the output folder.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const root = path.resolve(import.meta.dirname, "..", "..");

/** Returns an import function for a transpiled module, such as load("services/med-list-parser"). */
export async function transpileSources(cacheName, sources) {
  const out = path.join(root, "node_modules", ".cache", cacheName);
  for (const file of sources) {
    const code = await readFile(path.join(root, "src", file), "utf8");
    const { outputText } = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const target = path.join(out, file.replace(/\.ts$/, ".mjs"));
    const rewritten = outputText.replace(/from "@\/([^"]+)"/g, (_, spec) => {
      const absolute = path.join(out, `${spec}.mjs`);
      return `from "${pathToFileURL(absolute).href}"`;
    });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rewritten);
  }
  return (module) => import(pathToFileURL(path.join(out, `${module}.mjs`)).href);
}
