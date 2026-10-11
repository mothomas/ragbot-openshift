import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // components/ resolve "@/lib/..." the way Next does, so a lib test can reach one
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["frontend/lib/**/*.test.ts"] },
});
