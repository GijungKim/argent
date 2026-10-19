/**
 * Issue #1494: a `simctl list` that never answers must not pile up one call per
 * tick, and must not hold the watcher's `ready` (and so the server's listen)
 * forever.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const execSimctlMock = vi.fn();

vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return { ...actual, execSimctl: (...args: unknown[]) => execSimctlMock(...args) };
});

import type { Registry } from "@argent/registry";
import { SimctlTimeoutError } from "../src/utils/simctl-exec";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const registry = {
  resolveService: vi.fn(),
  disposeService: vi.fn(async () => {}),
} as unknown as Registry;

let stderrWrites: string[];

beforeEach(() => {
  execSimctlMock.mockReset();
  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("simulator-watcher with a hung simctl", () => {
  it("keeps one call in flight while simctl does not answer", async () => {
    let finish: (stdout: string) => void = () => {};
    execSimctlMock
      .mockResolvedValueOnce('{"devices":{}}')
      .mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(2);

    // Once it answers, the next tick polls again.
    finish('{"devices":{}}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(3);
    stop();
  });

  it("lets ready resolve when the first call times out, and says why once", async () => {
    execSimctlMock.mockRejectedValue(
      new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000)
    );

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    const hints = stderrWrites.filter((w) => w.includes("xcodebuild -runFirstLaunch"));
    expect(hints).toHaveLength(1);
  });

  it("logs the hint again after simctl recovers and hangs anew", async () => {
    const timeout = new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);
    execSimctlMock
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce('{"devices":{}}')
      .mockRejectedValue(timeout);

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    const hints = stderrWrites.filter((w) => w.includes("xcodebuild -runFirstLaunch"));
    expect(hints).toHaveLength(2);
  });

  it("aborts the in-flight call on stop", async () => {
    let signal: AbortSignal | undefined;
    execSimctlMock.mockImplementation((_args: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<string>(() => {});
    });

    const { stop } = startSimulatorWatcher(registry);
    expect(signal?.aborted).toBe(false);
    stop();
    expect(signal?.aborted).toBe(true);
  });
});
