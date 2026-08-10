import tseslint from "@electron-toolkit/eslint-config-ts";
import eslintConfigPrettier from "@electron-toolkit/eslint-config-prettier";
import eslintPluginReact from "eslint-plugin-react";
import eslintPluginReactHooks from "eslint-plugin-react-hooks";
import eslintPluginReactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  // .claude/worktrees holds git worktrees checked out inside the repo, so every
  // file in them is a second copy of the source and would be linted twice.
  // .cache holds generated browser profiles whose bundled extension scripts are
  // megabyte-long single lines — minutes each to parse, for no findings.
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/out",
      "**/out-ext",
      "**/.claude/worktrees",
      "**/.cache",
      "test-phase.mjs",
    ],
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat["jsx-runtime"],
  {
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": eslintPluginReactHooks,
      "react-refresh": eslintPluginReactRefresh,
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "react/no-unknown-property": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Plain-JS tooling scripts can't carry the type annotations the TS rules
    // ask for.
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  eslintConfigPrettier,
);
