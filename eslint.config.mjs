import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const NO_RELOAD = "Full page loads stop playback and reset the app — navigate with next/link or useRouter().";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The app must never reload itself: no hard navigations from app code.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "router", property: "refresh", message: "router.refresh() re-renders every server component — update the store instead." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "MemberExpression[property.name=/^(reload|assign|replace)$/]:matches([object.name='location'], [object.property.name='location'])", message: NO_RELOAD },
        { selector: "AssignmentExpression[left.property.name='href'][left.object.property.name='location']", message: NO_RELOAD },
        { selector: "AssignmentExpression[left.property.name='location'][left.object.name='window']", message: NO_RELOAD },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prototype code excluded from tsconfig (see commit b87bf70).
    "design/**",
    // Generated coverage output (vitest --coverage).
    "coverage/**",
    // Generated Prisma client.
    "src/generated/**",
    // Generated Convex bindings (npx convex dev / codegen).
    "convex/_generated/**",
  ]),
]);

export default eslintConfig;
