import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentFetch: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PHONE = "00008110-000978540290401E";
const SIMULATOR = "2E35A650-9618-41E1-9E8D-5E4E7CC20929";
let tmpDir: string;

function node(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return node({ role: "Application", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function mockRegistry(
  calls: Call[],
  nativeFailure?: Error,
  nativeResult: unknown = { tapped: true }
): Registry {
  return {
    invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === "list-devices") return { devices: [] };
      if (tool === "tap-element" && nativeFailure) throw nativeFailure;
      if (tool === "tap-element") return nativeResult;
      return { tapped: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, body: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), `steps:\n${body}`, "utf8");
}

function asRun(result: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in result)) throw new Error(`expected run result, got ${result.notice}`);
  return result;
}

async function run(
  name: string,
  calls: Call[],
  device: string,
  options: { nativeFailure?: Error; nativeResult?: unknown; signal?: AbortSignal } = {}
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(
      mockRegistry(calls, options.nativeFailure, options.nativeResult)
    ).execute(
      {},
      { name, project_root: tmpDir, device },
      options.signal ? ({ signal: options.signal } as never) : undefined
    )
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-native-tap-"));
  currentFetch = () => ({
    source: "xcuitest-runner",
    tree: screen([
      node({
        identifier: "PickerSearch",
        label: "Search",
        role: "AXTextField",
        frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.08 },
      }),
    ]),
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("physical iOS flow native element taps", () => {
  it("routes a strict unscoped identifier through tap-element using its actual casing", async () => {
    await writeFlow("native", "  - tap: { on: { id: pickersearch }, times: 2 }\n");
    const calls: Call[] = [];

    const result = await run("native", calls, PHONE);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        tool: "tap-element",
        args: {
          udid: PHONE,
          selector: { identifier: "PickerSearch" },
          clickCount: 2,
        },
      },
    ]);
  });

  it("keeps raw coordinates and non-physical platforms on gesture-tap", async () => {
    await writeFlow("raw", "  - tap: { x: 0.25, y: 0.75 }\n");
    await writeFlow("sim", "  - tap: { id: PickerSearch }\n");
    const rawCalls: Call[] = [];
    const simCalls: Call[] = [];

    expect((await run("raw", rawCalls, PHONE)).ok).toBe(true);
    expect((await run("sim", simCalls, SIMULATOR)).ok).toBe(true);
    expect(rawCalls).toEqual([{ tool: "gesture-tap", args: { udid: PHONE, x: 0.25, y: 0.75 } }]);
    expect(simCalls).toHaveLength(1);
    expect(simCalls[0]).toMatchObject({ tool: "gesture-tap", args: { udid: SIMULATOR, x: 0.5 } });
    expect(simCalls[0]?.args.y).toBeCloseTo(0.24);
  });

  it.each([
    ["loose", "  - tap: PickerSearch\n"],
    ["text", "  - tap: { text: Search }\n"],
    ["regex", "  - tap: { text: { matches: '^Search$' } }\n"],
    ["role-qualified", "  - tap: { id: PickerSearch, role: TextField }\n"],
    ["scoped", "  - tap: { id: PickerSearch, within: { role: Application } }\n"],
    ["any", "  - tap: { any: true, next: { text: Anchor } }\n"],
  ])("preserves the coordinate path for unsupported %s selectors", async (name, yaml) => {
    if (name === "scoped" || name === "any") {
      currentFetch = () => {
        const target = node({
          identifier: "PickerSearch",
          label: "Search",
          role: "AXTextField",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.08 },
        });
        return {
          source: "xcuitest-runner",
          tree:
            name === "scoped"
              ? screen([
                  node({
                    role: "Application",
                    frame: { x: 0, y: 0, width: 1, height: 1 },
                    children: [target],
                  }),
                ])
              : screen([
                  node({
                    label: "Anchor",
                    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
                  }),
                  target,
                ]),
        };
      };
    }
    await writeFlow(name, yaml);
    const calls: Call[] = [];

    expect((await run(name, calls, PHONE)).ok).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(["gesture-tap"]);
  });

  it("does not retry with coordinates when the native action fails", async () => {
    await writeFlow("failure", "  - tap: { id: PickerSearch }\n");
    const calls: Call[] = [];

    const result = await run("failure", calls, PHONE, {
      nativeFailure: new Error("ELEMENT_NOT_INTERACTABLE"),
    });

    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.tool === "tap-element")).toHaveLength(1);
    expect(calls.some((call) => call.tool === "gesture-tap")).toBe(false);
  });

  it("preserves a warning returned by the native element action", async () => {
    await writeFlow("warning", "  - tap: { id: PickerSearch }\n");
    const calls: Call[] = [];

    const result = await run("warning", calls, PHONE, {
      nativeResult: { tapped: true, warning: "native tap warning" },
    });

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.warning).toBe("native tap warning");
  });

  it("does not dispatch after cancellation during the settling read", async () => {
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads === 2) controller.abort();
      return {
        source: "xcuitest-runner",
        tree: screen([
          node({
            identifier: "PickerSearch",
            label: "Search",
            role: "AXTextField",
            frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.08 },
          }),
        ]),
      };
    };
    await writeFlow("cancelled", "  - tap: { id: PickerSearch }\n");
    const calls: Call[] = [];

    const result = await run("cancelled", calls, PHONE, { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "tap", status: "skip", reason: "run aborted" });
    expect(calls.some((call) => call.tool === "tap-element")).toBe(false);
    expect(calls.some((call) => call.tool === "gesture-tap")).toBe(false);
  });

  it("rejects duplicate exact identities before dispatch", async () => {
    const duplicate = () =>
      node({
        identifier: "PickerSearch",
        label: "Search",
        role: "AXTextField",
        frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.08 },
      });
    currentFetch = () => ({ source: "xcuitest-runner", tree: screen([duplicate(), duplicate()]) });
    await writeFlow("duplicate", "  - tap: { id: PickerSearch }\n");
    const calls: Call[] = [];

    const result = await run("duplicate", calls, PHONE);

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.reason).toContain("matched 2 elements");
    expect(
      calls.filter((call) => call.tool === "tap-element" || call.tool === "gesture-tap")
    ).toEqual([]);
  });

  it("lets the live identifier query reject a pruned duplicate with different fields", async () => {
    // The settled snapshot contains only the visible match. A second live
    // element with the same id but another label/role was pruned, so the runner
    // is the only authority that can report the ambiguity.
    currentFetch = () => ({
      source: "xcuitest-runner",
      tree: screen([
        node({
          identifier: "SharedId",
          label: "Visible search",
          role: "AXTextField",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.08 },
        }),
      ]),
    });
    await writeFlow("hidden-duplicate", "  - tap: { id: SharedId }\n");
    const calls: Call[] = [];

    const result = await run("hidden-duplicate", calls, PHONE, {
      nativeFailure: new Error("ELEMENT_AMBIGUOUS"),
    });

    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.tool === "tap-element")).toEqual([
      {
        tool: "tap-element",
        args: { udid: PHONE, selector: { identifier: "SharedId" } },
      },
    ]);
    expect(calls.some((call) => call.tool === "gesture-tap")).toBe(false);
  });
});
