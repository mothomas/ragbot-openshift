import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 400_000,
  workers: 1, // one model answers every question; parallel questions only queue behind each other
  outputDir: "test-results",
  reporter: [["list"]],
  use: {
    baseURL: process.env.TEST_WEB ?? "http://test.localhost:8081",
    browserName: "chromium",
    // retain-on-failure, not on-first-retry: on-first-retry needs retries, and a retry would let a
    // flaky required check pass. This keeps the trace of the run that actually failed.
    trace: "retain-on-failure",
  },
});
