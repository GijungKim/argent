/**
 * react-profiler-stop and a ReactProfilerSession teardown both end a run, so
 * both drop its stream-gate lease; the stop reports `streamRestored` when it
 * resumed a stream the start paused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import { ServiceState, TypedEventEmitter, type Registry } from "@argent/registry";

vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => os.tmpdir()),
  writeDumpCompact: vi.fn(async (_dir: string, name: string) => `/tmp/${name}`),
}));

import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { reactProfilerSessionBlueprint } from "../../src/blueprints/react-profiler-session";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";
import {
  __resetStreamGateForTesting,
  acquireStreamGate,
  attachStreamGateServer,
  isProfilingHeld,
  reactProfilerGateOwner,
} from "../../src/utils/stream-gate";

const DEV = "emulator-5554";
const OWNER = reactProfilerGateOwner(8081, DEV);
const posts: boolean[] = [];

function fakeCdp() {
  return {
    events: new TypedEventEmitter(),
    isConnected: () => true,
    evaluate: async () => undefined,
    send: async (method: string) => {
      if (method === "Profiler.stop") {
        return {
          profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1000 },
        };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify({ live: null, displayNameById: {} }) } };
      }
      return {};
    },
  };
}

/** A registry whose snapshot holds one running session for `DEV` on port 8081. */
function registryWithSession(): Registry {
  const api = {
    port: 8081,
    deviceId: DEV,
    cdp: fakeCdp(),
    profilingActive: true,
    disposeSession: vi.fn(),
  };
  return {
    getSnapshot: () => ({
      services: new Map([[`ReactProfilerSession:8081:${DEV}`, { state: ServiceState.RUNNING }]]),
    }),
    resolveService: async () => api,
  } as unknown as Registry;
}

describe("react profiler stream gate", () => {
  beforeEach(() => {
    posts.length = 0;
    __resetStreamGateForTesting();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        posts.push((JSON.parse(String(init?.body)) as { enabled: boolean }).enabled);
        return { status: 200 } as Response;
      })
    );
    attachStreamGateServer(DEV, { apiUrl: "http://127.0.0.1:5000" });
  });
  afterEach(() => {
    __resetStreamGateForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resumes on stop and reports streamRestored", async () => {
    await acquireStreamGate(DEV, OWNER);
    const result = await createReactProfilerStopTool(registryWithSession()).execute!(
      {},
      { port: 8081, device_id: DEV }
    );
    expect(result["streamRestored"]).toBe(true);
    expect(posts).toEqual([false, true]);
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("resumes when the stop fails", async () => {
    await acquireStreamGate(DEV, OWNER);
    const empty = {
      getSnapshot: () => ({ services: new Map() }),
    } as unknown as Registry;
    await expect(
      createReactProfilerStopTool(empty).execute!({}, { port: 8081, device_id: DEV })
    ).rejects.toThrow("No active profiling session");
    expect(posts).toEqual([false, true]);
  });

  it("omits streamRestored when the run held no lease", async () => {
    const result = await createReactProfilerStopTool(registryWithSession()).execute!(
      {},
      { port: 8081, device_id: DEV }
    );
    expect(result).not.toHaveProperty("streamRestored");
    expect(posts).toEqual([]);
  });

  it("resumes when the session is torn down (Metro reload, stop-all)", async () => {
    await acquireStreamGate(DEV, OWNER);
    const debuggerApi = {
      port: 8081,
      cdp: fakeCdp(),
    } as unknown as JsRuntimeDebuggerApi;
    const instance = await reactProfilerSessionBlueprint.factory(
      { debugger: debuggerApi },
      `8081:${DEV}`,
      undefined
    );
    await instance.dispose();
    await vi.waitFor(() => expect(posts).toEqual([false, true]));
    expect(isProfilingHeld(DEV)).toBe(false);
  });
});
