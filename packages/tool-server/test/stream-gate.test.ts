import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetStreamGateForTesting,
  acquireStreamGate,
  attachStreamGateServer,
  clearPreviewViewers,
  detachStreamGateServer,
  isProfilingHeld,
  nativeProfilerGateOwner,
  notePreviewViewer,
  reactProfilerGateOwner,
  releaseStreamGate,
} from "../src/utils/stream-gate";

const DEV = "emulator-5554";
const NATIVE = nativeProfilerGateOwner(DEV);
const REACT = reactProfilerGateOwner(8081, DEV);

/** A fake simulator-server `/api/stream` answering `status` (or throwing) and recording bodies. */
function fakeServer(apiUrl = "http://127.0.0.1:5000") {
  const posts: Array<{ enabled: boolean }> = [];
  let status = 200;
  let fail: Error | null = null;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${apiUrl}/api/stream`);
    expect(init?.method).toBe("POST");
    if (fail) throw fail;
    posts.push(JSON.parse(String(init?.body)) as { enabled: boolean });
    return { status } as Response;
  });
  return {
    api: { apiUrl },
    posts,
    fetchImpl,
    answer: (s: number) => (status = s),
    failWith: (e: Error | null) => (fail = e),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("stream gate", () => {
  beforeEach(() => {
    __resetStreamGateForTesting();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    __resetStreamGateForTesting();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pauses on the first lease and resumes after the last of overlapping leases", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);

    expect(await acquireStreamGate(DEV, NATIVE)).toEqual({ streamPaused: true });
    expect(await acquireStreamGate(DEV, REACT)).toEqual({ streamPaused: true });
    expect(s.posts).toEqual([{ enabled: false }]);
    expect(isProfilingHeld(DEV)).toBe(true);

    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: false });
    expect(s.posts).toHaveLength(1);
    expect(isProfilingHeld(DEV)).toBe(true);

    expect(await releaseStreamGate(REACT)).toEqual({ streamRestored: true });
    expect(s.posts).toEqual([{ enabled: false }, { enabled: true }]);
    expect(isProfilingHeld(DEV)).toBe(false);
    expect(await releaseStreamGate(REACT)).toBeNull();
  });

  it("refreshes a re-acquired lease instead of stacking a second one", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await acquireStreamGate(DEV, NATIVE);
    await acquireStreamGate(DEV, NATIVE);
    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: true });
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("serializes concurrent acquire and release per device", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await Promise.all([
      acquireStreamGate(DEV, NATIVE),
      acquireStreamGate(DEV, REACT),
      releaseStreamGate(NATIVE),
    ]);
    // Native's release lands after both acquires: one pause, still held by react.
    expect(s.posts).toEqual([{ enabled: false }]);
    expect(isProfilingHeld(DEV)).toBe(true);
  });

  it("defers the pause until a simulator-server attaches, and never needs one", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);

    const r = await acquireStreamGate(DEV, NATIVE);
    expect(r.streamPaused).toBe(false);
    expect(r.reason).toMatch(/no simulator-server/);
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(isProfilingHeld(DEV)).toBe(true);

    attachStreamGateServer(DEV, s.api);
    await flush();
    expect(s.posts).toEqual([{ enabled: false }]);
    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: true });
  });

  it("re-applies a held pause to a respawned server and forgets the dead one", async () => {
    const s1 = fakeServer();
    vi.stubGlobal("fetch", s1.fetchImpl);
    attachStreamGateServer(DEV, s1.api);
    await acquireStreamGate(DEV, NATIVE);
    detachStreamGateServer(DEV, s1.api);

    const s2 = fakeServer("http://127.0.0.1:6000");
    vi.stubGlobal("fetch", s2.fetchImpl);
    attachStreamGateServer(DEV, s2.api);
    await flush();
    expect(s2.posts).toEqual([{ enabled: false }]);
    // A stale detach from the first server must not unhook the second.
    detachStreamGateServer(DEV, s1.api);
    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: true });
    expect(s2.posts).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it.each([
    [501, /cannot pause/],
    [404, /too old/],
  ])("treats HTTP %s as a server that cannot pause, without retrying", async (status, reason) => {
    const s = fakeServer();
    s.answer(status);
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);

    const r = await acquireStreamGate(DEV, NATIVE);
    expect(r.streamPaused).toBe(false);
    expect(r.reason).toMatch(reason);
    // Leases still count: the MCP adapter skips its capture regardless.
    expect(isProfilingHeld(DEV)).toBe(true);
    await acquireStreamGate(DEV, REACT);
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: false });
    expect(await releaseStreamGate(REACT)).toEqual({ streamRestored: false });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never touches a server attached as unsupported (external provider, remote)", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api, "an external provider's simulator-server is left alone");
    const r = await acquireStreamGate(DEV, NATIVE);
    expect(r).toEqual({
      streamPaused: false,
      reason: "an external provider's simulator-server is left alone",
    });
    await releaseStreamGate(NATIVE);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failed pause and retries it on the next acquire", async () => {
    const s = fakeServer();
    s.answer(500);
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    const r = await acquireStreamGate(DEV, NATIVE);
    expect(r).toEqual({ streamPaused: false, reason: "POST /api/stream answered HTTP 500" });
    s.answer(200);
    expect(await acquireStreamGate(DEV, REACT)).toEqual({ streamPaused: true });
  });

  it("does not throw when the resume fails, and retries it once", async () => {
    vi.useFakeTimers();
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await acquireStreamGate(DEV, NATIVE);

    s.failWith(new Error("ECONNRESET"));
    expect(await releaseStreamGate(NATIVE)).toEqual({ streamRestored: false });
    s.failWith(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.posts).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("expires a lease after its TTL and resumes the stream", async () => {
    vi.useFakeTimers();
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await acquireStreamGate(DEV, NATIVE, 5_000);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(isProfilingHeld(DEV)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(isProfilingHeld(DEV)).toBe(false);
    expect(s.posts).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("reads the default TTL from ARGENT_PROFILING_STREAM_LEASE_MS", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARGENT_PROFILING_STREAM_LEASE_MS", "2000");
    await acquireStreamGate(DEV, NATIVE);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(isProfilingHeld(DEV)).toBe(false);
  });

  it("yields to an Argent Lens viewer and re-pauses once the window closes", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await acquireStreamGate(DEV, NATIVE);

    notePreviewViewer(DEV);
    await flush();
    expect(s.posts).toEqual([{ enabled: false }, { enabled: true }]);
    const r = await acquireStreamGate(DEV, REACT);
    expect(r).toEqual({
      streamPaused: false,
      reason: "an Argent Lens viewer is watching the stream",
    });

    clearPreviewViewers();
    await flush();
    expect(s.posts).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }]);
  });

  it("keeps devices independent", async () => {
    const s = fakeServer();
    vi.stubGlobal("fetch", s.fetchImpl);
    attachStreamGateServer(DEV, s.api);
    await acquireStreamGate("emulator-5556", nativeProfilerGateOwner("emulator-5556"));
    expect(isProfilingHeld(DEV)).toBe(false);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});
