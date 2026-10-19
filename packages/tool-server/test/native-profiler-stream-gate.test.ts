/**
 * native-profiler-start pauses the simulator-server stream once the capture is
 * up, and every way a capture ends resumes it: the stop (before the trace is
 * pulled), a stop that fails, the 10-minute cap and a session teardown. Drives
 * the real tools and Android platform code with perfetto, adb and the metadata
 * writer stubbed at their module boundaries, against the real gate and a fake
 * `/api/stream`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import * as os from "node:os";
import { ArtifactStore, type DeviceInfo } from "@argent/registry";

const events: string[] = [];

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));
vi.mock("../src/utils/adb", () => ({ adbShell: vi.fn(async () => "") }));
vi.mock("@argent/native-devtools-android", () => ({
  disposeWarmEngine: vi.fn(async () => {}),
  TraceProcessorUnavailableError: class extends Error {},
}));
vi.mock("../src/utils/android-profiler/detect-app", () => ({
  detectAndroidRunningApp: vi.fn(async () => "com.example.app"),
  validateAndroidAppProcess: vi.fn(async () => {}),
}));
vi.mock("../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => os.tmpdir()),
}));
vi.mock("../src/utils/android-profiler/session-metadata", () => ({
  writeAndroidNativeProfilerMetadata: vi.fn(async () => {}),
}));
const startPerfetto = vi.fn(async () => ({
  pid: 4242,
  onDeviceTracePath: "/data/misc/perfetto-traces/fake.pftrace",
  child: new EventEmitter() as unknown as ChildProcess,
}));
const stopPerfetto = vi.fn(
  async (opts: { hostTracePath: string; onCaptureEnded?: () => Promise<void> }) => {
    events.push("perfetto-stopped");
    await opts.onCaptureEnded?.();
    events.push("pulled");
    return { hostTracePath: opts.hostTracePath };
  }
);
vi.mock("../src/utils/android-profiler/capture", () => ({
  startPerfetto: (...a: unknown[]) => startPerfetto(...(a as [])),
  stopPerfetto: (...a: unknown[]) => stopPerfetto(...(a as [never])),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "../src/tools/profiler/native-profiler/native-profiler-stop";
import {
  __resetStreamGateForTesting,
  attachStreamGateServer,
  isProfilingHeld,
} from "../src/utils/stream-gate";
import { RECORDING_CAP_MS } from "../src/utils/profiler-shared/types";

const DEV = "emulator-5554";
const device = { id: DEV, platform: "android", kind: "emulator" } as DeviceInfo;

async function session() {
  return nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
}

function fakeStream(status = 200) {
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { enabled } = JSON.parse(String(init?.body)) as { enabled: boolean };
    events.push(enabled ? "resume" : "pause");
    return { status } as Response;
  });
  vi.stubGlobal("fetch", fetchImpl);
  attachStreamGateServer(DEV, { apiUrl: "http://127.0.0.1:5000" });
  return fetchImpl;
}

const start = (api: NativeProfilerSessionApi) =>
  nativeProfilerStartTool.execute({ session: api }, { device_id: DEV });
const stop = (api: NativeProfilerSessionApi) =>
  nativeProfilerStopTool.execute({ session: api }, { device_id: DEV }, {
    artifacts: new ArtifactStore(),
  } as never);

describe("native profiler stream gate", () => {
  beforeEach(() => {
    events.length = 0;
    __resetStreamGateForTesting();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    __resetStreamGateForTesting();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pauses after a successful start and resumes before the trace is pulled", async () => {
    fakeStream();
    const { api } = await session();

    const started = await start(api);
    expect(started).toMatchObject({ status: "recording", streamPaused: true });
    expect(started).not.toHaveProperty("streamNote");
    expect(isProfilingHeld(DEV)).toBe(true);

    const stopped = await stop(api);
    expect(stopped.streamRestored).toBe(true);
    expect(events).toEqual(["pause", "perfetto-stopped", "resume", "pulled"]);
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("says why when the device cannot pause, and omits streamRestored at stop", async () => {
    fakeStream(501);
    const { api } = await session();
    const started = await start(api);
    expect(started).toMatchObject({ streamPaused: false, streamNote: expect.any(String) });
    // Still held, so the MCP adapter skips its capture.
    expect(isProfilingHeld(DEV)).toBe(true);
    const stopped = await stop(api);
    expect(stopped).not.toHaveProperty("streamRestored");
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("does not touch the stream when the start fails", async () => {
    const fetchImpl = fakeStream();
    startPerfetto.mockRejectedValueOnce(new Error("perfetto refused"));
    const { api } = await session();
    await expect(start(api)).rejects.toThrow("perfetto refused");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("resumes when the stop fails", async () => {
    fakeStream();
    const { api } = await session();
    await start(api);
    stopPerfetto.mockRejectedValueOnce(new Error("adb pull failed"));
    await expect(stop(api)).rejects.toThrow("adb pull failed");
    expect(events).toEqual(["pause", "resume"]);
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("resumes at the recording cap, without waiting for the stop", async () => {
    vi.useFakeTimers();
    fakeStream();
    const { api } = await session();
    await start(api);
    await vi.advanceTimersByTimeAsync(RECORDING_CAP_MS);
    expect(events).toEqual(["pause", "resume"]);
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("resumes when the session is torn down mid-capture", async () => {
    fakeStream();
    const instance = await session();
    await start(instance.api);
    await instance.dispose();
    await vi.waitFor(() => expect(events).toEqual(["pause", "resume"]));
    expect(isProfilingHeld(DEV)).toBe(false);
  });
});
