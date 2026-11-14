// Pure decisions for the canary. Callers pass the time and the previous state.
// This file does not fetch, touch KV, or read the clock.

export type Status = "up" | "down" | "unknown";

export interface TargetState {
  status: Status;
  consecutiveFailures: number;
  lastCheck: number;
  lastBeat?: number;
  detail?: string;
}

export interface CheckResult {
  healthy: boolean;
  detail?: string;
}

export interface Decision {
  state: TargetState;
  alert: "up" | "down" | null;
  change: string | null;
}

export type ScheduledInput =
  | {
      id: string;
      kind: "http";
      prev: TargetState;
      now: number;
      httpResult: CheckResult;
      failuresBeforeAlert: number;
    }
  | {
      id: string;
      kind: "beat";
      prev: TargetState;
      now: number;
      staleAfterMinutes: number;
    };

export function emptyState(): TargetState {
  return { status: "unknown", consecutiveFailures: 0, lastCheck: 0 };
}

export function resolveBeatHost(rawHost: string, ids: readonly string[]): string | null {
  const host = rawHost.trim();
  if (!ids.includes(host)) return null;
  return host;
}

export function beatAuthorized(header: string | null, secret: string | undefined): boolean {
  if (secret === undefined || secret.length === 0) return false;
  const matches = header !== null && sameSecret(header, secret);
  return matches;
}

export function sameSecret(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  let difference = bytesA.length ^ bytesB.length;
  const longest = Math.max(bytesA.length, bytesB.length);
  for (let index = 0; index < longest; index += 1) {
    difference |= (bytesA[index] ?? 0) ^ (bytesB[index] ?? 0);
  }
  return difference === 0;
}

export function interpretHttp(status: number, expect: readonly number[]): CheckResult {
  if (expect.includes(status)) return { healthy: true };
  return {
    healthy: false,
    detail: "HTTP " + status + " (expected " + expect.join("/") + ")",
  };
}

export function interpretHttpError(message: string): CheckResult {
  return { healthy: false, detail: "fetch failed: " + message };
}

export function decideScheduled(input: ScheduledInput): Decision {
  if (input.kind === "beat") {
    const lastBeat = input.prev.lastBeat;
    if (lastBeat === undefined) {
      const unseenStatus: Status = "unknown";
      return {
        state: {
          status: unseenStatus,
          consecutiveFailures: 0,
          lastCheck: input.now,
          detail: "never reported a heartbeat",
        },
        alert: null,
        change: input.id + ":awaiting-first-beat",
      };
    }
    return transition({
      id: input.id,
      prev: input.prev,
      result: beatResult(lastBeat, input.now, input.staleAfterMinutes),
      threshold: 1,
      now: input.now,
    });
  }

  return transition({
    id: input.id,
    prev: input.prev,
    result: input.httpResult,
    threshold: input.failuresBeforeAlert,
    now: input.now,
  });
}

export function recordBeat(prev: TargetState, now: number): Decision {
  const decision = transition({
    id: "beat",
    prev,
    result: { healthy: true },
    threshold: 1,
    now,
  });
  return {
    state: {
      status: decision.state.status,
      consecutiveFailures: decision.state.consecutiveFailures,
      lastCheck: now,
      lastBeat: now,
    },
    alert: decision.alert,
    change: decision.change,
  };
}

function beatResult(lastBeat: number, now: number, staleAfterMinutes: number): CheckResult {
  const ageMin = Math.floor((now - lastBeat) / 60000);
  const withinLimit = ageMin <= staleAfterMinutes;
  if (withinLimit) return { healthy: true };
  const staleHealthy = false;
  return {
    healthy: staleHealthy,
    detail: "last heartbeat " + ageMin + "m ago (threshold " + staleAfterMinutes + "m)",
  };
}

function transition(input: {
  id: string;
  prev: TargetState;
  result: CheckResult;
  threshold: number;
  now: number;
}): Decision {
  const failures = input.result.healthy ? 0 : input.prev.consecutiveFailures + 1;
  const enough = failures >= input.threshold;
  const nowDown = !input.result.healthy && enough;
  const effective = effectiveStatus(input.result.healthy, nowDown, input.prev.status);
  const flipped = effective !== input.prev.status;
  const seenBefore = input.prev.status !== "unknown";
  const alerting = flipped && seenBefore;
  const alert = alerting ? (effective === "down" ? "down" : "up") : null;
  const change = alert
    ? input.id + ":" + input.prev.status + "->" + effective
    : input.prev.status === "unknown"
      ? input.id + ":baseline=" + effective
      : null;
  return {
    state: {
      status: effective,
      consecutiveFailures: failures,
      lastCheck: input.now,
      lastBeat: input.prev.lastBeat,
      detail: input.result.detail,
    },
    alert,
    change,
  };
}

function effectiveStatus(healthy: boolean, nowDown: boolean, prevStatus: Status): "up" | "down" {
  if (nowDown) return "down";
  if (healthy) return "up";
  if (prevStatus === "down") return "down";
  return "up";
}
