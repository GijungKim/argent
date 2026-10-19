import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";
import {
  __resetStreamGateForTesting,
  acquireStreamGate,
  nativeProfilerGateOwner,
} from "../src/utils/stream-gate";

// Keep the update note out of these assertions, as the other http-*.test.ts do.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  const def = {
    id: "test-tool",
    description: "A stub tool for testing",
    inputSchema: { type: "object", properties: {} },
    services: () => ({}),
    execute: async () => ({ tapped: true }),
  };
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) => (name === "test-tool" ? def : undefined)),
    invokeTool: vi.fn(async () => ({ tapped: true })),
  } as unknown as Registry;
}

// The MCP adapter skips its post-action capture on this flag.
describe("HTTP profiling envelope flag", () => {
  let handle: HttpAppHandle;

  beforeEach(() => {
    __resetStreamGateForTesting();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    handle?.dispose();
    __resetStreamGateForTesting();
    vi.restoreAllMocks();
  });

  it("is absent when no profiler holds the call's device", async () => {
    handle = createHttpApp(stubRegistry());
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .send({ udid: "emulator-5554" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { tapped: true } });
  });

  it("is set while a profiler holds the call's device, on both response paths", async () => {
    await acquireStreamGate("emulator-5554", nativeProfilerGateOwner("emulator-5554"));
    handle = createHttpApp(stubRegistry());

    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .send({ udid: "emulator-5554" });
    expect(res.body).toEqual({ data: { tapped: true }, profiling: true });

    const streamed = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({ udid: "emulator-5554" });
    const result = streamed.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; profiling?: boolean })
      .find((l) => l.event === "result");
    expect(result?.profiling).toBe(true);
  });

  it("is scoped to the profiled device", async () => {
    await acquireStreamGate("emulator-5554", nativeProfilerGateOwner("emulator-5554"));
    handle = createHttpApp(stubRegistry());
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .send({ udid: "emulator-5556" });
    expect(res.body.profiling).toBeUndefined();
  });
});
