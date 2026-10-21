import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { tapElement, type RunnerElementSelector } from "../../utils/ios-device/runner-commands";
import { RunnerCommandError } from "../../utils/ios-device/runner-client";
import { assertSupported } from "../../utils/capability";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";

const ELEMENT_TAP_FAILURE_CODES = new Set([
  "ELEMENT_NOT_FOUND",
  "ELEMENT_AMBIGUOUS",
  "ELEMENT_NOT_INTERACTABLE",
]);

/**
 * Registry/HTTP failures retain the runner failure signal but serialize only
 * the message, not RunnerCommandError.code. Add this tool's stable public code
 * to that message without replacing the error or its existing taxonomy.
 */
function surfaceElementTapFailureCode(error: unknown): never {
  if (
    error instanceof RunnerCommandError &&
    error.code !== undefined &&
    ELEMENT_TAP_FAILURE_CODES.has(error.code) &&
    !error.message.includes(error.code)
  ) {
    error.message = `${error.code}: ${error.message}`;
  }
  throw error;
}

const selectorSchema = z
  .object({
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe("Exact, case-sensitive accessibility identifier from `describe`."),
    label: z
      .string()
      .min(1)
      .optional()
      .describe("Exact, case-sensitive accessibility label from `describe`."),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Exact, case-sensitive role from `describe` (for example AXButton or AXTextField). " +
          "The runner maps that describe role back to its XCUI element type."
      ),
  })
  .strict()
  .refine((selector) => selector.identifier !== undefined || selector.label !== undefined, {
    message: "selector needs identifier or label; role alone is not specific enough",
  });

export const tapElementSchema = z
  .object({
    udid: z.string().min(1).describe("Target physical iPhone UDID from `list-devices`."),
    selector: selectorSchema.describe(
      "Exact live-element selector. Every supplied field is ANDed and matched case-sensitively."
    ),
    clickCount: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        "Number of taps sent as one native action (2 uses XCUIElement.doubleTap; above 2 uses " +
          "separate live-element taps on-device). Default 1."
      ),
  })
  .strict();

type Params = z.infer<typeof tapElementSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
  /** The runner re-fronted the target app before tapping it. */
  reactivated?: true;
  /** Accessibility noise occurred during the mutation; confirm the effect. */
  warning?: string;
}

const capability: ToolCapability = {
  apple: { device: true },
};

/**
 * Public physical-iOS native element tap. Selector values deliberately never
 * enter interaction/event-log messages.
 */
export const tapElementTool: ToolDefinition<Params, Result> = {
  id: "tap-element",
  interaction: {
    startedMsg: () => "Tapping a native element",
    completedMsg: () => "Tapped a native element",
    failedMsg: ({ failureSignal }) => `Failed to tap a native element: ${failureSignal.error_code}`,
  },
  description: `Tap a live accessibility element on a physical iPhone through XCUIElement, without converting a snapshot frame to coordinates.
Every supplied selector field is an exact, case-sensitive AND constraint. Pass at least identifier or label; role alone is rejected. Use role values exactly as \`describe\` emits them (for example \`AXTextField\`); role is the describe-to-XCUI type mapping, not a fuzzy substring.
Use this when coordinate taps are unreliable, including controls such as picker search fields: \`{ label: "Search", role: "AXTextField" }\`. Set clickCount: 2 for native doubleTap. The runner rejects zero matches (ELEMENT_NOT_FOUND), multiple matches (ELEMENT_AMBIGUOUS), and a matched element that cannot be tapped (ELEMENT_NOT_INTERACTABLE).
Physical iOS only. There is no coordinate fallback or retry after native lookup/action failure. Returns { tapped: true, timestampMs }; reactivated: true means the target app was re-fronted, so re-describe the screen first.`,
  searchHint:
    "physical iphone ios tap live native accessibility element selector identifier label role xcui",
  zodSchema: tapElementSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return isIosPhysicalDevice(device) ? { iosDeviceRunner: iosDeviceRunnerRef(device) } : {};
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    assertSupported("tap-element", capability, device);
    const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
    const bundleId = requireCurrentIosDeviceApp(device.id);
    const timestampMs = Date.now();
    const result = await tapElement(
      runner,
      bundleId,
      params.selector as RunnerElementSelector,
      params.clickCount
    ).catch(surfaceElementTapFailureCode);
    return {
      tapped: true,
      timestampMs,
      ...(result.reactivated ? { reactivated: true as const } : {}),
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
    };
  },
};
