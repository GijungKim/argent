/**
 * Pauses a device's simulator-server video stream while a profiler records.
 *
 * The stream encodes continuously, and on a phone the encoder raises the CPU
 * clocks enough to make app threads look lighter than they are and to hide
 * jank. Each profiler run holds a lease keyed by its owner; native and React
 * profiling overlap by design, so the stream is paused by the first lease on a
 * device and resumed when the last one goes. The MCP adapter also reads the
 * leases (via the tool-call envelope) to skip its post-action capture, which
 * loads the profiled app just as much.
 *
 * Simulator-server contract: `POST /api/stream {"enabled": bool}`. 501 means the
 * device cannot pause (iOS), 404 an older binary without the route. A
 * screenshot taken while paused is resumed for and fresh, server-side.
 *
 * Invariants:
 *  - Never spawns a simulator-server. With none running, the pause is applied
 *    by {@link attachStreamGateServer} when one starts.
 *  - Never throws into a profiler tool: failures become a reason string.
 *  - A lease expires after a TTL, so a lost stop cannot leave a device dark.
 *  - Yields to an Argent Lens viewer: a human is watching that stream.
 */
import type { SimulatorServerApi } from "../blueprints/simulator-server";

const STREAM_ENDPOINT = "/api/stream";
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 3_000;
const RESUME_RETRY_MS = 1_000;
/** A Lens viewer counts as live this long after it last attached. */
const PREVIEW_VIEWER_TTL_MS = 30 * 60 * 1000;

type GateServer = Pick<SimulatorServerApi, "apiUrl">;

interface DeviceGate {
  deviceId: string;
  /** Owner → TTL timer. */
  leases: Map<string, NodeJS.Timeout>;
  server: GateServer | null;
  /** Why the attached server cannot pause; null = supported or not yet known. */
  unsupported: string | null;
  /** Whether this module paused the attached server. */
  paused: boolean;
  /** Why the last reconcile left the stream running although leases are held. */
  reason: string | null;
  chain: Promise<unknown>;
}

interface StreamGateAcquireResult {
  streamPaused: boolean;
  /** Why the stream was not paused; absent when it was. */
  reason?: string;
}

interface StreamGateReleaseResult {
  /** True when this release resumed a stream the gate had paused. */
  streamRestored: boolean;
}

const gates = new Map<string, DeviceGate>();
const ownerToDevice = new Map<string, string>();
const previewViewers = new Map<string, number>();

function log(deviceId: string, msg: string): void {
  process.stderr.write(`[stream-gate ${deviceId}] ${msg}\n`);
}

function leaseMs(): number {
  const n = Number(process.env.ARGENT_PROFILING_STREAM_LEASE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEASE_MS;
}

function gateFor(deviceId: string): DeviceGate {
  let g = gates.get(deviceId);
  if (!g) {
    g = {
      deviceId,
      leases: new Map(),
      server: null,
      unsupported: null,
      paused: false,
      reason: null,
      chain: Promise.resolve(),
    };
    gates.set(deviceId, g);
  }
  return g;
}

function serialize<T>(g: DeviceGate, fn: () => Promise<T>): Promise<T> {
  const run = g.chain.then(fn);
  g.chain = run.catch(() => {});
  return run;
}

function viewerWatching(deviceId: string): boolean {
  const seen = previewViewers.get(deviceId);
  return seen !== undefined && Date.now() - seen < PREVIEW_VIEWER_TTL_MS;
}

async function postStream(server: GateServer, enabled: boolean): Promise<number> {
  const res = await fetch(`${server.apiUrl}${STREAM_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => {});
  return res.status;
}

/** Bring the attached server to the state the leases ask for. Serialized per device. */
function reconcile(g: DeviceGate): Promise<void> {
  return serialize(g, async () => {
    const wantPaused = g.leases.size > 0 && !viewerWatching(g.deviceId);
    g.reason = null;
    if (g.leases.size > 0 && !wantPaused) g.reason = "an Argent Lens viewer is watching the stream";
    const server = g.server;
    if (!server) {
      if (wantPaused) g.reason = "no simulator-server is running for this device yet";
      return;
    }
    if (wantPaused === g.paused) return;
    if (g.unsupported) {
      if (wantPaused) g.reason = g.unsupported;
      return;
    }
    let status: number;
    try {
      status = await postStream(server, !wantPaused);
    } catch (err) {
      const msg = `POST ${STREAM_ENDPOINT} failed: ${err instanceof Error ? err.message : String(err)}`;
      if (wantPaused) g.reason = msg;
      else scheduleResumeRetry(g, server, msg);
      return;
    }
    if (status === 404 || status === 501) {
      g.unsupported =
        status === 404
          ? "simulator-server too old to pause the stream"
          : "this device cannot pause its stream";
      if (wantPaused) g.reason = g.unsupported;
      return;
    }
    if (status < 200 || status >= 300) {
      const msg = `POST ${STREAM_ENDPOINT} answered HTTP ${status}`;
      if (wantPaused) g.reason = msg;
      else scheduleResumeRetry(g, server, msg);
      return;
    }
    g.paused = wantPaused;
    log(g.deviceId, wantPaused ? "stream paused" : "stream resumed");
  });
}

/** One delayed retry; a failed resume must not fail the profiler stop. */
function scheduleResumeRetry(g: DeviceGate, server: GateServer, msg: string): void {
  log(g.deviceId, `resume failed (${msg}); retrying once`);
  const t = setTimeout(() => {
    if (g.server !== server || !g.paused) return;
    void reconcile(g).then(() => {
      if (g.server === server && g.paused && g.leases.size === 0) {
        log(g.deviceId, "resume failed again; the stream stays paused until it restarts");
      }
    });
  }, RESUME_RETRY_MS);
  t.unref?.();
}

/**
 * Take (or refresh) `owner`'s lease on `deviceId`. Call only after the profiler
 * started successfully. Never throws.
 */
export async function acquireStreamGate(
  deviceId: string,
  owner: string,
  ttlMs: number = leaseMs()
): Promise<StreamGateAcquireResult> {
  const prev = ownerToDevice.get(owner);
  if (prev && prev !== deviceId) await releaseStreamGate(owner);
  const g = gateFor(deviceId);
  const existing = g.leases.get(owner);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    log(deviceId, `lease ${owner} expired after ${ttlMs} ms`);
    void releaseStreamGate(owner);
  }, ttlMs);
  timer.unref?.();
  g.leases.set(owner, timer);
  ownerToDevice.set(owner, deviceId);
  try {
    await reconcile(g);
  } catch (err) {
    g.reason = String(err);
  }
  return g.paused ? { streamPaused: true } : { streamPaused: false, reason: g.reason ?? "unknown" };
}

/**
 * Drop `owner`'s lease. The stream resumes when the last lease on the device
 * goes. Returns null when `owner` held none. Never throws.
 */
export async function releaseStreamGate(owner: string): Promise<StreamGateReleaseResult | null> {
  const deviceId = ownerToDevice.get(owner);
  if (!deviceId) return null;
  ownerToDevice.delete(owner);
  const g = gateFor(deviceId);
  const timer = g.leases.get(owner);
  if (timer) clearTimeout(timer);
  g.leases.delete(owner);
  const wasPaused = g.paused;
  try {
    await reconcile(g);
  } catch {
    // reconcile never rejects; belt and braces for the never-throws contract.
  }
  return { streamRestored: wasPaused && !g.paused };
}

/**
 * Called once a simulator-server for `deviceId` is up. A fresh server streams,
 * so a held lease is applied now (fire-and-forget, not delaying the spawn).
 * `unsupported` marks a server the gate must leave alone (external provider,
 * remote transport).
 */
export function attachStreamGateServer(
  deviceId: string,
  server: GateServer,
  unsupported: string | null = null
): void {
  const g = gateFor(deviceId);
  g.server = server;
  g.paused = false;
  g.unsupported = unsupported;
  if (g.leases.size > 0) void reconcile(g);
}

export function detachStreamGateServer(deviceId: string, server: GateServer): void {
  const g = gates.get(deviceId);
  if (!g || g.server !== server) return;
  g.server = null;
  g.paused = false;
  g.unsupported = null;
}

/** Whether a profiler holds a lease on `deviceId`, whatever the stream does. */
export function isProfilingHeld(deviceId: string): boolean {
  return (gates.get(deviceId)?.leases.size ?? 0) > 0;
}

/** The /preview route calls this when a Lens viewer attaches to a device. */
export function notePreviewViewer(deviceId: string): void {
  previewViewers.set(deviceId, Date.now());
  const g = gates.get(deviceId);
  if (g?.paused) void reconcile(g);
}

/** The Lens window closed: re-pause any device a profiler still holds. */
export function clearPreviewViewers(): void {
  const ids = [...previewViewers.keys()];
  previewViewers.clear();
  for (const id of ids) {
    const g = gates.get(id);
    if (g && g.leases.size > 0) void reconcile(g);
  }
}

/** Lease owner ids, so start, stop, the recording cap and dispose agree. */
export const nativeProfilerGateOwner = (deviceId: string) => `native-profiler:${deviceId}`;
export const reactProfilerGateOwner = (port: number, deviceId: string) =>
  `react-profiler:${port}:${deviceId}`;

export function __resetStreamGateForTesting(): void {
  for (const g of gates.values()) for (const t of g.leases.values()) clearTimeout(t);
  gates.clear();
  ownerToDevice.clear();
  previewViewers.clear();
}
