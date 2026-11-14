/**
 * What the canary watches.
 *
 * Two kinds of check:
 *  - `http`  : the edge fetches a public URL and asserts the status code.
 *  - `beat`  : a dead-man switch. The host POSTs /beat and the edge alerts when
 *              the last beat goes stale. This watches a machine that is not
 *              publicly reachable, and it still fires when that machine is off.
 */

export interface HttpTarget {
  kind: "http";
  id: string;
  label: string;
  url: string;
  /** Any of these status codes counts as healthy. */
  expect: number[];
  /** Consecutive failures before alerting. Absorbs one-off edge blips. */
  failuresBeforeAlert: number;
  fix: string;
}

export interface BeatTarget {
  kind: "beat";
  id: string;
  label: string;
  /** Minutes without a beat before the host is considered down. */
  staleAfterMinutes: number;
  fix: string;
}

export type Target = HttpTarget | BeatTarget;

export const TARGETS: Target[] = [
  {
    kind: "http",
    id: "site",
    label: "example.com",
    url: "https://example.com",
    expect: [200],
    failuresBeforeAlert: 2,
    fix: "Check that the site responds with the expected status.",
  },
  {
    kind: "http",
    id: "www",
    label: "www.example.com",
    url: "https://www.example.com",
    expect: [200, 302, 307],
    failuresBeforeAlert: 2,
    fix: "Check that the site responds. A redirect in the expected list is healthy.",
  },
  {
    kind: "beat",
    id: "machine",
    label: "machine",
    staleAfterMinutes: 30,
    fix: "Check that the machine is on and its heartbeat job is running.",
  },
];
