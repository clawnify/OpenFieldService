#!/usr/bin/env node
// Phase 11.1 — Core / Module architecture-boundary guard.
//
// Plain Node script, zero new dependencies (only node:fs/node:path). NOT a
// vitest test: empirically confirmed (see docs/PLATFORM-GENERALIZATION-AUDIT.md
// Phase 11.1 addendum) that @cloudflare/vitest-pool-workers runs test files
// inside a bundled sandbox with no access to the real project filesystem
// (`readdir` there resolves against a virtual `/bundle/` root, not the repo),
// so a filesystem-scanning check cannot live inside `pnpm test`. This script
// is the equivalent guard, run separately (`pnpm run check:architecture`).
//
// Rule: files outside src/{server,client}/modules/ ("Core") must never import
// from src/{server,client}/modules/** ("Industry/Regional modules") — except
// the composition roots, which are explicitly allowed to import a module
// (that's their job). Within modules/, an industry module (hvac/) must never
// import from a regional program module (programs/**) — the allowed
// dependency direction is the reverse (programs may depend on an industry
// module when genuinely necessary), never industry-on-region.
//
// Composition roots: src/server/index.ts and src/client/app.tsx (the two
// application-composition entry points, allowed to import every module), plus
// src/server/workflow.ts (Phase 11.2 — narrowly-scoped exception: Core's
// job-type/workflow registry must be assembled in the same module scope as
// the engine functions that consume it, so workflow.ts imports ONLY pure
// data — no business logic — from modules/programs/bc/workflow-definitions.ts.
// See workflow.ts's own header comment for the full justification.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["src/server", "src/client"];
const COMPOSITION_ROOTS = new Set(["src/server/index.ts", "src/client/app.tsx", "src/server/workflow.ts"]);
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function isUnderModules(relPath) {
  return /\/modules\//.test(relPath);
}

function isUnderHvac(relPath) {
  return /\/modules\/hvac\//.test(relPath);
}

function isUnderPrograms(relPath) {
  return /\/modules\/programs\//.test(relPath);
}

function resolveImportTarget(fileDir, specifier) {
  if (!specifier.startsWith(".")) return null; // external package, not a repo-relative concern
  return path.normalize(path.join(fileDir, specifier)).replace(/\\/g, "/");
}

async function main() {
  const violations = [];

  for (const root of ROOTS) {
    const files = await walk(root);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const fileDir = path.dirname(file);
      let match;
      IMPORT_RE.lastIndex = 0;
      while ((match = IMPORT_RE.exec(content))) {
        const specifier = match[1];
        const target = resolveImportTarget(fileDir, specifier);
        if (!target) continue;

        const fileIsModule = isUnderModules(file);
        const targetIsModule = isUnderModules(target);
        const fileIsCompositionRoot = COMPOSITION_ROOTS.has(file);

        // Rule 1: Core (non-module, non-composition-root) must never import a module.
        if (!fileIsModule && !fileIsCompositionRoot && targetIsModule) {
          violations.push(`${file}: Core file imports a module path "${specifier}" (resolves under ${target}) — Core must not depend on Industry/Regional modules.`);
        }

        // Rule 2: an HVAC (industry) file must never import a programs/ (regional) file.
        if (isUnderHvac(file) && isUnderPrograms(target)) {
          violations.push(`${file}: HVAC module file imports a regional-program path "${specifier}" — wrong direction (programs may depend on an industry module, not the reverse).`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ Architecture boundary violations found (${violations.length}):\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error("");
    process.exit(1);
  }

  console.log("✅ Architecture boundaries clean: no Core file imports a module (outside the composition roots), and no HVAC file imports a regional-program file.");
}

main().catch((err) => {
  console.error("Architecture boundary check crashed:", err);
  process.exit(1);
});
