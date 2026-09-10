import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".wrangler/**", "worker-configuration.d.ts", "apps/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Phase 11.1 — plain Node dev-tooling scripts (never bundled into the
    // Worker or the browser build), same tier as vitest.config.ts's own
    // node:fs usage but needing ambient `console`/`process` globals too.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Phase 19A — Playwright-driven E2E helper scripts: plain Node at the
    // top level (console/process/fetch), but also pass closures into
    // page.evaluate() that execute in the BROWSER (document/window) —
    // ESLint parses those statically and can't tell them apart, so this
    // tier gets both global sets, same reasoning as **/*.{ts,tsx} above.
    files: ["test/e2e/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
);
