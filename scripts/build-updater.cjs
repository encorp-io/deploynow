/**
 * Compiles the self-updater (src/lib/selfUpdate/runner.ts and the two modules it
 * needs) to plain CommonJS in updater/. The Docker image ships it at
 * /app/updater, where `require("dockerode")` finds /app/node_modules.
 *
 *   node scripts/build-updater.cjs [outDir]
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "updater"));
const FILES = ["lib/selfUpdate/runner.ts", "lib/selfUpdate/shared.ts", "lib/docker/recreate.ts"];

fs.rmSync(out, { recursive: true, force: true });
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(root, "src", rel), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(src, {
    fileName: rel,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, verbatimModuleSyntax: false },
  });
  if (diagnostics?.length) {
    console.error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    process.exit(1);
  }
  // Only relative imports between these files and packages are allowed
  for (const m of outputText.matchAll(/require\("([^"]+)"\)/g)) {
    const spec = m[1];
    if (spec.startsWith(".")) {
      const target = path.normalize(path.join(path.dirname(rel), spec)) + ".ts";
      if (!FILES.includes(target)) throw new Error(`${rel} requires ${spec}, which the updater doesn't ship`);
    } else if (!["fs", "path", "dockerode"].includes(spec)) {
      throw new Error(`${rel} requires ${spec}; the updater may only use fs, path and dockerode`);
    }
  }
  const dest = path.join(out, rel.replace(/^lib\//, "").replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, outputText);
}
console.log(`[build-updater] ${FILES.length} files → ${path.relative(root, out) || out}`);
