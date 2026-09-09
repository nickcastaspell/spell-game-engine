import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 15000,
    fileParallelism: false, // ogni test file usa un proprio DB sqlite: niente bisogno di isolamento speciale, ma evitiamo I/O concorrente sullo stesso mount
  },
});
