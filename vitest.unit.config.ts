import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "unit",
    include: ["shared/**/*.test.ts", "src/**/*.test.ts"],
  },
});
