import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // `pilots/**` is the #339 eve spike — a parallel pilot outside the pnpm workspace that imports
    // `eve`/`zod` (not installed at the repo root). It is build/typecheck-isolated and lint-isolated.
    ignores: ["**/dist/**", "**/dist-ssr/**", "**/node_modules/**", "**/*.config.js", "**/*.config.ts", "pilots/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
