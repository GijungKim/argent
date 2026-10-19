/**
 * execSimctl against real processes: a stub `xcrun` first on PATH stands in
 * for Xcode 27.1's simctl wrapper, a bash script that can hang in a child
 * `xcodebuild -runFirstLaunch`. The point is that a timeout or abort reaps that
 * child too, not only the direct one.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSimctl, SimctlTimeoutError } from "../src/utils/simctl-exec";

let dir: string;
let originalPath: string | undefined;
const childPidFile = (): string => path.join(dir, "child.pid");

function childIsAlive(): boolean {
  const pid = Number(fs.readFileSync(childPidFile(), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChildPid(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(childPidFile()) || !fs.readFileSync(childPidFile(), "utf8").trim()) {
    if (Date.now() > deadline) throw new Error("stub never started its child");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-simctl-exec-"));
  // `hang` runs a background-free child like the wrapper's xcodebuild call and
  // records its pid; `fail` exits non-zero; anything else echoes its args.
  fs.writeFileSync(
    path.join(dir, "xcrun"),
    `#!/bin/bash
case "$2" in
  hang) sleep 600 & echo $! > "${dir}/child.pid"; wait ;;
  fail) echo "boom" >&2; exit 3 ;;
  *) echo "out:$*" ;;
esac
`,
    { mode: 0o755 }
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("execSimctl", () => {
  it("resolves with stdout", async () => {
    await expect(execSimctl(["simctl", "list"])).resolves.toBe("out:simctl list\n");
  });

  it("rejects with stderr on a non-zero exit", async () => {
    await expect(execSimctl(["simctl", "fail"])).rejects.toThrow(/code 3: boom/);
  });

  it("kills the wrapper's child on timeout", async () => {
    fs.rmSync(childPidFile(), { force: true });
    const call = execSimctl(["simctl", "hang"], { timeoutMs: 500 });
    await waitForChildPid();
    await expect(call).rejects.toBeInstanceOf(SimctlTimeoutError);
    await new Promise((r) => setTimeout(r, 100));
    expect(childIsAlive()).toBe(false);
  });

  it("kills the wrapper's child on abort", async () => {
    fs.rmSync(childPidFile(), { force: true });
    const controller = new AbortController();
    const call = execSimctl(["simctl", "hang"], { timeoutMs: 60_000, signal: controller.signal });
    await waitForChildPid();
    controller.abort();
    await expect(call).rejects.toThrow(/aborted/);
    await new Promise((r) => setTimeout(r, 100));
    expect(childIsAlive()).toBe(false);
  });
});
