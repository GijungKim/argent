---
name: argent-ios-device-interact
description: Drive a physical iPhone through argent. Use when a physical iPhone is involved (a list-devices iOS entry with kind "device") and ONLY then; never for a simulator. For cable, trust, or signing problems read argent-ios-device-setup.
---

# Physical iPhone interaction

Read this only for a physical iPhone. `argent-device-interact` still applies for everything not listed here.

## Contract

- Observation never changes the screen; mutation may. `describe` and `await-ui-element` fail on a backgrounded target instead of re-fronting it; `await-screen-idle` returns `settled: false` with no reason. The first `describe` within a second of `button home` can still return the old tree; describe again. Gestures and `keyboard` re-front it and return `reactivated: true`; re-describe before the next step.
- `launch-app`, `open-url` and `restart-app` set the app under automation; `reinstall-app` clears it; a tool-server restart forgets it: launch again.
- Each tool's description states its own hardware limits (named keys, `gesture-custom` shapes, buttons, edge swipes, tap counts). A gated tool fails with a bare `not supported on ios device`: the fix is in the list below, not in the error.

## Tools on hardware

- Only these exist: `list-devices`, `launch-app`, `restart-app`, `reinstall-app`, `open-url`, `describe`, `screenshot`, `screenshot-diff`, `tap-element`, `gesture-tap`, `gesture-swipe`, `gesture-custom`, `button` (`home`, `volumeUp`, `volumeDown`, `actionButton` on models that have one), `keyboard`, `await-ui-element`, `await-screen-idle`, `run-sequence`, the e2e tools, `stop-simulator-server` and `stop-all-simulator-servers` (session end). Every other device tool fails with `not supported on ios device`.
- Prefer `tap-element` when a control has a stable identifier or label in `describe`, especially when a snapshot frame can be stale or misleading. Its selector fields are exact and case-sensitive, are ANDed, and require `identifier` or `label`; copy the actual `describe` values, including roles such as `AXTextField`. A native lookup/action failure never retries at coordinates. Use `gesture-tap` for raw points or elements without a precise accessibility selector. `tap-element` is not a `run-sequence` step.
- Physical-iPhone flow replay auto-routes only a strict, unscoped `tap: { id: ... }` with no role or other selector field through the live native action. It sends the resolved element's actual identifier casing; role-qualified, text, loose, regex, `any`, and relational flow selectors keep their coordinate behavior.
- No two-finger gestures, `rotate`, `shake`, `paste`, `settings-permissions`, screen recording, `debugger-*`, `react-profiler-*`, `native-profiler-*`, `native-*`, `boot-device`: drive the app's own zoom and rotate UI with taps and drags, move the phone by hand, type with `keyboard`, change permissions in the phone's Settings, and debug, profile or record on a simulator.
- `gesture-swipe`: `durationMs` sets drag speed, not time; `momentum:false` only rests 300 ms at the end, no damping. `open-url` https lands in Safari, never in the app that owns the link: pass `bundleId`.
