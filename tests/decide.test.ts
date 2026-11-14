import { expect, test } from "bun:test";
import { beatAuthorized, decideScheduled, type TargetState } from "../src/decide";
import { interpretHttp, interpretHttpError, recordBeat, resolveBeatHost, sameSecret } from "../src/decide";

const NOW = 1700000000000;
const MINUTE = 60000;

function state(partial: Partial<TargetState> & Pick<TargetState, "status">): TargetState {
  return {
    consecutiveFailures: 0,
    lastCheck: 0,
    ...partial,
  };
}

test("first sight of a target", () => {
  // source: the first observation is a baseline and does not alert
  const decision = decideScheduled({
    id: "site",
    kind: "http",
    prev: state({ status: "unknown" }),
    now: NOW,
    httpResult: { healthy: true },
    failuresBeforeAlert: 2,
  });

  expect(decision.state.status).toBe("up");
  expect(decision.state.consecutiveFailures).toBe(0);
  expect(decision.state.lastCheck).toBe(NOW);
  expect(decision.alert).toBeNull();
  expect(decision.change).toBe("site:baseline=up");
});

test("up to down flips after two failures and not after one", () => {
  // source: a URL alerts only after two failures in a row
  const once = decideScheduled({
    id: "site",
    kind: "http",
    prev: state({ status: "up", lastCheck: NOW - MINUTE }),
    now: NOW,
    httpResult: { healthy: false, detail: "HTTP 500 (expected 200)" },
    failuresBeforeAlert: 2,
  });

  expect(once.state.status).toBe("up");
  expect(once.state.consecutiveFailures).toBe(1);
  expect(once.alert).toBeNull();
  expect(once.change).toBeNull();

  const twice = decideScheduled({
    id: "site",
    kind: "http",
    prev: once.state,
    now: NOW + MINUTE,
    httpResult: { healthy: false, detail: "HTTP 500 (expected 200)" },
    failuresBeforeAlert: 2,
  });

  expect(twice.state.status).toBe("down");
  expect(twice.state.consecutiveFailures).toBe(2);
  expect(twice.alert).toBe("down");
  expect(twice.change).toBe("site:up->down");
});

test("down to up flips at once", () => {
  // source: one healthy check clears a down target and alerts immediately
  const decision = decideScheduled({
    id: "site",
    kind: "http",
    prev: state({ status: "down", consecutiveFailures: 2, lastCheck: NOW - MINUTE }),
    now: NOW,
    httpResult: { healthy: true },
    failuresBeforeAlert: 2,
  });

  expect(decision.state.status).toBe("up");
  expect(decision.state.consecutiveFailures).toBe(0);
  expect(decision.state.lastCheck).toBe(NOW);
  expect(decision.alert).toBe("up");
  expect(decision.change).toBe("site:down->up");
});

test("no alert when the state is unchanged", () => {
  // source: the same status on the next check does not alert
  const stillUp = decideScheduled({
    id: "site",
    kind: "http",
    prev: state({ status: "up", lastCheck: NOW - MINUTE }),
    now: NOW,
    httpResult: { healthy: true },
    failuresBeforeAlert: 2,
  });

  expect(stillUp.state.status).toBe("up");
  expect(stillUp.state.lastCheck).toBe(NOW);
  expect(stillUp.alert).toBeNull();
  expect(stillUp.change).toBeNull();

  const stillDown = decideScheduled({
    id: "site",
    kind: "http",
    prev: state({ status: "down", consecutiveFailures: 2, lastCheck: NOW - MINUTE }),
    now: NOW,
    httpResult: { healthy: false, detail: "HTTP 500 (expected 200)" },
    failuresBeforeAlert: 2,
  });

  expect(stillDown.state.status).toBe("down");
  expect(stillDown.state.consecutiveFailures).toBe(3);
  expect(stillDown.state.lastCheck).toBe(NOW);
  expect(stillDown.alert).toBeNull();
  expect(stillDown.change).toBeNull();
});

test("a heartbeat inside its limit is up", () => {
  // source: a beat at or under its minute limit is up
  const limit = 20;
  const atLimit = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "up", lastCheck: NOW - limit * MINUTE, lastBeat: NOW - limit * MINUTE }),
    now: NOW,
    staleAfterMinutes: limit,
  });

  expect(atLimit.state.status).toBe("up");
  expect(atLimit.state.lastBeat).toBe(NOW - limit * MINUTE);
  expect(atLimit.state.lastCheck).toBe(NOW);
  expect(atLimit.alert).toBeNull();
  expect(atLimit.state.detail).toBeUndefined();

  const younger = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "up", lastCheck: NOW - 5 * MINUTE, lastBeat: NOW - 5 * MINUTE }),
    now: NOW,
    staleAfterMinutes: limit,
  });

  expect(younger.state.status).toBe("up");
  expect(younger.alert).toBeNull();
});

test("a stale heartbeat is down", () => {
  // source: a beat older than its minute limit is down
  const limit = 20;
  const age = 21;
  const decision = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "up", lastCheck: NOW - age * MINUTE, lastBeat: NOW - age * MINUTE }),
    now: NOW,
    staleAfterMinutes: limit,
  });

  expect(decision.state.status).toBe("down");
  expect(decision.state.consecutiveFailures).toBe(1);
  expect(decision.state.lastBeat).toBe(NOW - age * MINUTE);
  expect(decision.state.lastCheck).toBe(NOW);
  expect(decision.state.detail).toBe("last heartbeat 21m ago (threshold 20m)");
  expect(decision.alert).toBe("down");
  expect(decision.change).toBe("machine:up->down");
});

test("a host never heard from is unknown and raises no down alert", () => {
  // source: a beat target with no heartbeat stays unknown and does not alert
  const decision = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "unknown" }),
    now: NOW,
    staleAfterMinutes: 20,
  });

  expect(decision.state.status).toBe("unknown");
  expect(decision.state.detail).toBe("never reported a heartbeat");
  expect(decision.state.lastBeat).toBeUndefined();
  expect(decision.state.lastCheck).toBe(NOW);
  expect(decision.state.consecutiveFailures).toBe(0);
  expect(decision.alert).toBeNull();
  expect(decision.change).toBe("machine:awaiting-first-beat");
});

test("a missing or wrong secret on /beat is refused", () => {
  // source: /beat accepts only a header that matches the configured secret
  expect(beatAuthorized(null, "example-secret")).toBe(false);
  expect(beatAuthorized("nope", "example-secret")).toBe(false);
  expect(beatAuthorized("example-secret", undefined)).toBe(false);
  expect(beatAuthorized("example-secret", "")).toBe(false);
  expect(beatAuthorized("", "")).toBe(false);
  expect(beatAuthorized("example-secret", "example-secret")).toBe(true);
});

test("recordBeat stores the beat time and marks the host up", () => {
  // source: a heartbeat records its own time and the host counts as up
  const first = recordBeat(state({ status: "unknown" }), NOW);

  expect(first.state.status).toBe("up");
  expect(first.state.lastBeat).toBe(NOW);
  expect(first.state.lastCheck).toBe(NOW);
  expect(first.state.consecutiveFailures).toBe(0);
  expect(first.state.detail).toBeUndefined();
  expect(first.alert).toBeNull();

  const again = recordBeat(
    state({ status: "up", lastCheck: NOW - 5 * MINUTE, lastBeat: NOW - 5 * MINUTE }),
    NOW,
  );

  expect(again.state.status).toBe("up");
  expect(again.state.lastBeat).toBe(NOW);
  expect(again.state.lastCheck).toBe(NOW);
  expect(again.alert).toBeNull();
});

test("recordBeat on a host that was down raises an up alert", () => {
  // source: a heartbeat that arrives while the host is down is a recovery worth announcing
  const decision = recordBeat(
    state({
      status: "down",
      consecutiveFailures: 1,
      lastCheck: NOW - MINUTE,
      lastBeat: NOW - 40 * MINUTE,
      detail: "last heartbeat 40m ago (threshold 30m)",
    }),
    NOW,
  );

  expect(decision.alert).toBe("up");
  expect(decision.change).toBe("beat:down->up");
  expect(decision.state.status).toBe("up");
  expect(decision.state.consecutiveFailures).toBe(0);
  expect(decision.state.lastBeat).toBe(NOW);
  expect(decision.state.detail).toBeUndefined();
});

test("resolveBeatHost accepts a listed id, trims spaces around it and refuses any other", () => {
  // source: /beat accepts only the ids of beat targets
  const ids = ["machine", "other"];

  expect(resolveBeatHost("machine", ids)).toBe("machine");
  expect(resolveBeatHost("  machine ", ids)).toBe("machine");
  expect(resolveBeatHost("other", ids)).toBe("other");
  expect(resolveBeatHost("site", ids)).toBeNull();
  expect(resolveBeatHost("", ids)).toBeNull();
  expect(resolveBeatHost("   ", ids)).toBeNull();
  expect(resolveBeatHost("Machine", ids)).toBeNull();
  expect(resolveBeatHost("machine", [])).toBeNull();
});

test("interpretHttp treats a listed status as healthy and names the status it got otherwise", () => {
  // source: a status in the expect list is healthy; any other status is named in the detail
  expect(interpretHttp(200, [200])).toEqual({ healthy: true });
  expect(interpretHttp(302, [200, 302, 307])).toEqual({ healthy: true });

  const unlisted = interpretHttp(500, [200]);
  expect(unlisted.healthy).toBe(false);
  expect(unlisted.detail).toBe("HTTP 500 (expected 200)");

  const redirect = interpretHttp(301, [200, 302, 307]);
  expect(redirect.healthy).toBe(false);
  expect(redirect.detail).toBe("HTTP 301 (expected 200/302/307)");
});

test("interpretHttpError is unhealthy and carries the message", () => {
  // source: a fetch that throws is a failed check and its message is kept
  const result = interpretHttpError("connection refused");

  expect(result.healthy).toBe(false);
  expect(result.detail).toBe("fetch failed: connection refused");
});

test("sameSecret is true only when every byte matches", () => {
  // source: the secret is compared over every byte, so no near miss is accepted
  expect(sameSecret("example-secret", "example-secret")).toBe(true);
  expect(sameSecret("", "")).toBe(true);

  expect(sameSecret("xxample-secret", "example-secret")).toBe(false);
  expect(sameSecret("example-secrex", "example-secret")).toBe(false);
  expect(sameSecret("example", "example-secret")).toBe(false);
  expect(sameSecret("example-secret", "example")).toBe(false);
  expect(sameSecret("", "example-secret")).toBe(false);
  expect(sameSecret("example-secret", "")).toBe(false);
  expect(sameSecret("Example-Secret", "example-secret")).toBe(false);
  expect(sameSecret("example-secret\u0000", "example-secret")).toBe(false);
  expect(sameSecret("example-secret", "example-secret\u0000")).toBe(false);
  expect(sameSecret("caf\u00e9", "caf\u00e8")).toBe(false);
  expect(sameSecret("caf\u00e9", "caf\u00e9")).toBe(true);
});

test("beatAuthorized accepts the exact secret and nothing near it", () => {
  // source: /beat, /run and /test-alert accept only a header equal to the configured secret
  const secret = "example-secret";

  expect(beatAuthorized(secret, secret)).toBe(true);
  expect(beatAuthorized(null, secret)).toBe(false);
  expect(beatAuthorized("", secret)).toBe(false);
  expect(beatAuthorized(secret + "x", secret)).toBe(false);
  expect(beatAuthorized(secret.slice(0, -1), secret)).toBe(false);
  expect(beatAuthorized("Example-Secret", secret)).toBe(false);
  expect(beatAuthorized(" " + secret + " ", secret)).toBe(false);

  expect(beatAuthorized("", undefined)).toBe(false);
  expect(beatAuthorized(null, undefined)).toBe(false);
  expect(beatAuthorized("", "")).toBe(false);
  expect(beatAuthorized(null, "")).toBe(false);
});

test("heartbeat age is counted in whole minutes, rounded down", () => {
  // source: the age of a beat is whole minutes rounded down, compared with the limit
  const limit = 30;
  const justInside = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "up", lastCheck: NOW - 31 * MINUTE, lastBeat: NOW - (limit * MINUTE + 59999) }),
    now: NOW,
    staleAfterMinutes: limit,
  });

  expect(justInside.state.status).toBe("up");
  expect(justInside.alert).toBeNull();
  expect(justInside.state.detail).toBeUndefined();

  const over = decideScheduled({
    id: "machine",
    kind: "beat",
    prev: state({ status: "up", lastCheck: NOW - 31 * MINUTE, lastBeat: NOW - 31 * MINUTE }),
    now: NOW,
    staleAfterMinutes: limit,
  });

  expect(over.state.status).toBe("down");
  expect(over.alert).toBe("down");
  expect(over.state.detail).toBe("last heartbeat 31m ago (threshold 30m)");
});
