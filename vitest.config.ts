import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts", "src/proxy.ts"],
      exclude: [
        "src/lib/prisma.ts",          // singleton — no logic to test
        "src/lib/auth.ts",            // NextAuth config — integration tested
        "src/lib/backgroundPoller.ts", // timer loop — tested via polling.ts
        "src/app/api/auth/**",         // NextAuth handler re-export
        "src/lib/portainer.ts",        // heavy HTTP I/O — tested via integration
      ],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 75,
        lines: 80,
      },
    },
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
