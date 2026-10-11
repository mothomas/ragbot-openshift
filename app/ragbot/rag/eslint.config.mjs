import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next brings jsx-a11y's recommended rules; the strict set is what the accessibility budget asks for
  { files: ["**/*.{ts,tsx}"], rules: { ...jsxA11y.flatConfigs.strict.rules, "no-empty": "error", "no-console": "error", "@typescript-eslint/no-unused-vars": "error" } },
  // last, so it wins: Prettier owns layout and this turns off every rule that would argue with it
  prettier,
  // the built export is not a source (its config root is rag/, not rag/frontend)
  globalIgnores(["**/.next/**", "**/out/**", "**/node_modules/**", "**/next-env.d.ts"]),
]);
