import { afterEach, beforeEach, expect, test } from "bun:test";
import { TARGETS } from "../src/config";
import worker, { type Env } from "../src/index";

// source: every request path and every alert goes through the Worker's own handlers, with the
// network and the key-value store replaced by stand-ins

const SECRET = "example-secret";
const TOKEN = "example-token";
const CHAT = "example-chat";
const TELEGRAM_PREFIX = "https://api.telegram.org/";
const SITE_URL = "https://example.com";
const WWW_URL = "https://www.example.com";
const MINUTE = 60000;

interface Call {
  url: string;
  body: string | null;
  init: RequestInit | undefined;
}

interface Stored {
  status: string;
  consecutiveFailures: number;
  lastCheck: number;
  lastBeat?: number;
  detail?: string;
  pendingAlert?: string;
}

type Handler = () => Response;

interface FakeKv {
  store: Map<string, string>;
  puts: string[];
  get(key: string, type?: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let unexpected: string[] = [];
let routes = new Map<string, Handler>();

function ok(): Response {
  return new Response("{}", { status: 200 });
}

function answerStatus(status: number): Handler {
  return () => new Response("stand-in", { status });
}

beforeEach(() => {
  calls = [];
  unexpected = [];
  routes = new Map<string, Handler>([
    [SITE_URL, ok],
    [WWW_URL, ok],
    [TELEGRAM_PREFIX, ok],
  ]);
  const recorder = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body, init });
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler();
    }
    unexpected.push(url);
    throw new Error("unexpected request to " + url);
  };
  globalThis.fetch = recorder as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(unexpected).toEqual([]);
});

function makeKv(): FakeKv {
  const store = new Map<string, string>();
  const puts: string[] = [];
  return {
    store,
    puts,
    async get(key: string, type?: string): Promise<unknown> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string): Promise<void> {
      puts.push(key);
      store.set(key, value);
    },
  };
}

interface Rig {
  kv: FakeKv;
  env: Env;
}

function makeRig(settings: { secret?: string; token?: string; chat?: string } = {
  secret: SECRET,
  token: TOKEN,
  chat: CHAT,
}): Rig {
  const kv = makeKv();
  const env: Env = {
    CANARY: kv as unknown as Env["CANARY"],
    BEAT_SECRET: settings.secret,
    TELEGRAM_BOT_TOKEN: settings.token,
    TELEGRAM_CHAT_ID: settings.chat,
  };
  return { kv, env };
}

function target(id: string): (typeof TARGETS)[number] {
  const found = TARGETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error("no target " + id);
  return found;
}

function request(method: string, path: string, secret?: string): Request {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers["x-canary-secret"] = secret;
  return new Request("https://example.com" + path, { method, headers });
}

async function runScheduled(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
    passThroughOnException(): void {},
  } as unknown as Parameters<typeof worker.scheduled>[2];
  const controller = {
    scheduledTime: Date.now(),
    cron: "*/5 * * * *",
    noRetry(): void {},
  } as unknown as Parameters<typeof worker.scheduled>[0];
  await worker.scheduled(controller, env, context);
  await Promise.all(pending);
}

function seed(kv: FakeKv, id: string, state: Stored): void {
  kv.store.set("state:" + id, JSON.stringify(state));
}

function stored(kv: FakeKv, id: string): Stored {
  const raw = kv.store.get("state:" + id);
  if (raw === undefined) throw new Error("nothing stored for " + id);
  return JSON.parse(raw) as Stored;
}

function telegramCalls(): Call[] {
  return calls.filter((call) => call.url.startsWith(TELEGRAM_PREFIX));
}

function messages(): string[] {
  const out: string[] = [];
  for (const call of telegramCalls()) {
    if (call.body === null) continue;
    const parsed: unknown = JSON.parse(call.body);
    if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
      const text = (parsed as { text: unknown }).text;
      if (typeof text === "string") out.push(text);
    }
  }
  return out;
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) return false;
  }
  return true;
}

test("POST /beat without the secret is refused with 401 and stores nothing", async () => {
  const { kv, env } = makeRig();
  const res = await worker.fetch(request("POST", "/beat?host=machine"), env);

  expect(res.status).toBe(401);
  expect(await res.text()).toBe("unauthorized");
  expect(kv.store.size).toBe(0);
  expect(calls).toEqual([]);
});

test("POST /beat with a wrong secret is refused with 401", async () => {
  const { kv, env } = makeRig();
  const res = await worker.fetch(request("POST", "/beat?host=machine", "not-the-secret"), env);

  expect(res.status).toBe(401);
  expect(kv.store.size).toBe(0);
});

test("POST /beat is refused with 401 when no secret is configured, even with a header", async () => {
  const unset = makeRig({ token: TOKEN, chat: CHAT });
  const withHeader = await worker.fetch(request("POST", "/beat?host=machine", "anything"), unset.env);
  expect(withHeader.status).toBe(401);
  expect(unset.kv.store.size).toBe(0);

  const empty = makeRig({ secret: "", token: TOKEN, chat: CHAT });
  const emptyHeader = await worker.fetch(request("POST", "/beat?host=machine", ""), empty.env);
  expect(emptyHeader.status).toBe(401);
  expect(empty.kv.store.size).toBe(0);
});

test("POST /beat for an unknown host is refused with 400 and stores nothing", async () => {
  const { kv, env } = makeRig();
  for (const path of ["/beat?host=bogus", "/beat?host=site", "/beat?host=", "/beat"]) {
    const res = await worker.fetch(request("POST", path, SECRET), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown host" });
  }
  expect(kv.store.size).toBe(0);
  expect(calls).toEqual([]);
});

test("POST /beat with the secret stores the beat time for that host and marks it up", async () => {
  const { kv, env } = makeRig();
  const before = Date.now();
  const res = await worker.fetch(request("POST", "/beat?host=machine", SECRET), env);
  const after = Date.now();

  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; host: string; at: number };
  expect(body.ok).toBe(true);
  expect(body.host).toBe("machine");
  expect(body.at).toBeGreaterThanOrEqual(before);
  expect(body.at).toBeLessThanOrEqual(after);

  const state = stored(kv, "machine");
  expect(state.status).toBe("up");
  expect(state.consecutiveFailures).toBe(0);
  expect(state.lastBeat).toBeGreaterThanOrEqual(before);
  expect(state.lastBeat).toBeLessThanOrEqual(after);
  expect(state.lastBeat).toBe(body.at);
  expect([...kv.store.keys()]).toEqual(["state:machine"]);
  expect(telegramCalls().length).toBe(0);
});

test("GET /status needs no secret and lists every configured target", async () => {
  const { env } = makeRig();
  const res = await worker.fetch(request("GET", "/status"), env);

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, { status: string; label: string }>;
  expect(Object.keys(body)).toEqual(TARGETS.map((configured) => configured.id));
  for (const configured of TARGETS) {
    expect(body[configured.id]?.label).toBe(configured.label);
    expect(body[configured.id]?.status).toBe("unknown");
  }
});

test("GET /health needs no secret and reports the target count", async () => {
  const { env } = makeRig();
  const res = await worker.fetch(request("GET", "/health"), env);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, targets: TARGETS.length });
  expect(TARGETS.length).toBeGreaterThan(0);
});

test("POST /run without the secret is refused with 401 and makes no outbound request", async () => {
  const { kv, env } = makeRig();
  const missing = await worker.fetch(request("POST", "/run"), env);
  const wrong = await worker.fetch(request("POST", "/run", "not-the-secret"), env);

  expect(missing.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(calls).toEqual([]);
  expect(kv.store.size).toBe(0);
});

test("POST /test-alert without the secret is refused with 401 and makes no outbound request", async () => {
  const { env } = makeRig();
  const missing = await worker.fetch(request("POST", "/test-alert"), env);
  const wrong = await worker.fetch(request("POST", "/test-alert", "not-the-secret"), env);

  expect(missing.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(calls).toEqual([]);
});

test("an unknown path gets 404", async () => {
  const { kv, env } = makeRig();
  const unknown = await worker.fetch(request("GET", "/nope"), env);
  expect(unknown.status).toBe(404);

  const wrongMethod = await worker.fetch(request("GET", "/beat?host=machine", SECRET), env);
  expect(wrongMethod.status).toBe(404);
  const wrongRun = await worker.fetch(request("GET", "/run", SECRET), env);
  expect(wrongRun.status).toBe(404);

  expect(kv.store.size).toBe(0);
  expect(calls).toEqual([]);
});

test("POST /run with the secret runs the checks and lists the changes", async () => {
  const { kv, env } = makeRig();
  const res = await worker.fetch(request("POST", "/run", SECRET), env);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ran: true,
    changes: ["site:baseline=up", "www:baseline=up", "machine:awaiting-first-beat"],
  });
  expect(stored(kv, "site").status).toBe("up");
});

test("POST /test-alert with the secret sends the fixed alert text", async () => {
  const { env } = makeRig();
  const res = await worker.fetch(request("POST", "/test-alert", SECRET), env);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sent: true });
  expect(telegramCalls().length).toBe(1);
  expect(telegramCalls()[0]?.url).toBe(TELEGRAM_PREFIX + "bot" + TOKEN + "/sendMessage");
  const sent = messages();
  expect(sent).toEqual(["fleet-canary test alert. If you see this, the alert path works."]);
  expect(isAscii(sent[0] ?? "")).toBe(true);
});

test("a first scheduled run stores a baseline for each site and sends no alert", async () => {
  const { kv, env } = makeRig();
  await runScheduled(env);

  expect(calls.filter((call) => call.url === SITE_URL).length).toBe(1);
  expect(calls.filter((call) => call.url === WWW_URL).length).toBe(1);
  expect(telegramCalls().length).toBe(0);

  for (const id of ["site", "www"]) {
    const state = stored(kv, id);
    expect(state.status).toBe("up");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastCheck).toBeGreaterThan(0);
  }
  const machine = stored(kv, "machine");
  expect(machine.status).toBe("unknown");
  expect(machine.detail).toBe("never reported a heartbeat");
});

test("a site that fails twice in a row raises exactly one down alert, on the second failure, and none on the third", async () => {
  const { kv, env } = makeRig();
  routes.set(SITE_URL, answerStatus(500));

  await runScheduled(env);
  expect(telegramCalls().length).toBe(0);
  expect(stored(kv, "site").status).toBe("up");
  expect(stored(kv, "site").consecutiveFailures).toBe(1);

  await runScheduled(env);
  expect(telegramCalls().length).toBe(1);
  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").consecutiveFailures).toBe(2);
  expect(messages()).toEqual([
    target("site").label + " is DOWN. HTTP 500 (expected 200)\n\nFix: " + target("site").fix,
  ]);

  await runScheduled(env);
  expect(telegramCalls().length).toBe(1);
  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").consecutiveFailures).toBe(3);
});

test("a site that comes back raises exactly one up alert", async () => {
  const { kv, env } = makeRig();
  seed(kv, "site", { status: "down", consecutiveFailures: 2, lastCheck: 1, detail: "HTTP 500 (expected 200)" });

  await runScheduled(env);
  expect(messages()).toEqual([target("site").label + " is back UP."]);
  expect(stored(kv, "site").status).toBe("up");
  expect(stored(kv, "site").consecutiveFailures).toBe(0);

  await runScheduled(env);
  expect(telegramCalls().length).toBe(1);
});

test("a heartbeat older than its limit raises exactly one down alert on a scheduled run, and the next POST /beat raises exactly one up alert", async () => {
  const { kv, env } = makeRig();
  const machine = target("machine");
  if (machine.kind !== "beat") throw new Error("machine is not a beat target");
  const limit = machine.staleAfterMinutes;
  const lastBeat = Date.now() - (limit + 1) * MINUTE;
  seed(kv, "site", { status: "up", consecutiveFailures: 0, lastCheck: 1 });
  seed(kv, "www", { status: "up", consecutiveFailures: 0, lastCheck: 1 });
  seed(kv, "machine", { status: "up", consecutiveFailures: 0, lastCheck: lastBeat, lastBeat });

  await runScheduled(env);
  expect(telegramCalls().length).toBe(1);
  const down = messages()[0] ?? "";
  expect(down.startsWith(target("machine").label + " is DOWN. last heartbeat " + (limit + 1) + "m ago")).toBe(true);
  expect(stored(kv, "machine").status).toBe("down");
  expect(stored(kv, "machine").lastBeat).toBe(lastBeat);

  const res = await worker.fetch(request("POST", "/beat?host=machine", SECRET), env);
  expect(res.status).toBe(200);
  expect(telegramCalls().length).toBe(2);
  expect(messages()[1]).toBe(target("machine").label + " is back UP (heartbeat resumed).");
  expect(stored(kv, "machine").status).toBe("up");
  expect(stored(kv, "machine").lastBeat).toBeGreaterThan(lastBeat);
});

test("with the Telegram settings missing a flip sends nothing and the new state is still stored", async () => {
  const variants = [
    { secret: SECRET, chat: CHAT },
    { secret: SECRET, token: TOKEN },
    { secret: SECRET },
  ];
  for (const variant of variants) {
    calls = [];
    const { kv, env } = makeRig(variant);
    seed(kv, "site", { status: "down", consecutiveFailures: 2, lastCheck: 1 });

    await runScheduled(env);

    expect(telegramCalls().length).toBe(0);
    expect(stored(kv, "site").status).toBe("up");
    expect(stored(kv, "site").consecutiveFailures).toBe(0);
  }
});

test("every alert text that was sent names the target's label, says DOWN or UP, and holds only ASCII characters", async () => {
  const { kv, env } = makeRig();
  const siteLabel = target("site").label;
  const machineLabel = target("machine").label;

  routes.set(SITE_URL, answerStatus(500));
  await runScheduled(env);
  await runScheduled(env);
  routes.set(SITE_URL, ok);
  await runScheduled(env);

  const machineTarget = target("machine");
  if (machineTarget.kind !== "beat") throw new Error("machine is not a beat target");
  const lastBeat = Date.now() - (machineTarget.staleAfterMinutes + 1) * MINUTE;
  seed(kv, "machine", { status: "up", consecutiveFailures: 0, lastCheck: lastBeat, lastBeat });
  await runScheduled(env);
  await worker.fetch(request("POST", "/beat?host=machine", SECRET), env);

  const sent = messages();
  expect(sent.length).toBe(4);
  const expected: Array<[string, string]> = [
    [siteLabel, "DOWN"],
    [siteLabel, "UP"],
    [machineLabel, "DOWN"],
    [machineLabel, "UP"],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const text = sent[index] ?? "";
    const [label, word] = expected[index] ?? ["", ""];
    expect(text.startsWith(label + " ")).toBe(true);
    expect(text.includes(" is " + word) || text.includes(" is back " + word)).toBe(true);
    expect(isAscii(text)).toBe(true);
  }
});

function answerThrow(): Response {
  throw new Error("stand-in refuses to answer");
}

const NEAR_MISSES = ["example-secrets", "example-secre", "Example-Secret"];

test("POST /beat, /run and /test-alert refuse a secret that is longer, shorter or in another case", async () => {
  for (const path of ["/beat?host=machine", "/run", "/test-alert"]) {
    for (const nearMiss of NEAR_MISSES) {
      const { kv, env } = makeRig();
      const res = await worker.fetch(request("POST", path, nearMiss), env);

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("unauthorized");
      expect(kv.store.size).toBe(0);
      expect(calls).toEqual([]);
    }
  }
});

test("a URL check is sent with redirect manual, the fleet-canary user agent and a 12000 millisecond timeout", async () => {
  const { env } = makeRig();
  const original = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (milliseconds: number): AbortSignal => {
    timeouts.push(milliseconds);
    return original.call(AbortSignal, milliseconds);
  };
  try {
    await runScheduled(env);
  } finally {
    AbortSignal.timeout = original;
  }

  expect(telegramCalls().length).toBe(0);
  const siteCalls = calls.filter((call) => call.url === SITE_URL || call.url === WWW_URL);
  expect(siteCalls.length).toBe(2);
  for (const call of siteCalls) {
    expect(call.init?.redirect).toBe("manual");
    expect(new Headers(call.init?.headers).get("user-agent")).toBe("fleet-canary (Cloudflare Worker)");
    expect(call.init?.signal instanceof AbortSignal).toBe(true);
  }
  const httpTargets = TARGETS.filter((configured) => configured.kind === "http");
  expect(timeouts).toEqual(httpTargets.map(() => 12000));
});

test("an alert send that throws does not stop the run", async () => {
  const { kv, env } = makeRig();
  seed(kv, "site", { status: "up", consecutiveFailures: 1, lastCheck: 1 });
  routes.set(SITE_URL, answerStatus(500));
  routes.set(TELEGRAM_PREFIX, answerThrow);
  const before = Date.now();

  const res = await worker.fetch(request("POST", "/run", SECRET), env);

  expect(res.status).toBe(200);
  const body = (await res.json()) as { ran: boolean; changes: string[] };
  expect(body.ran).toBe(true);
  expect(body.changes).toContain("site:up->down");
  expect(telegramCalls().length).toBe(1);
  for (const configured of TARGETS) {
    expect(stored(kv, configured.id).lastCheck).toBeGreaterThanOrEqual(before);
  }
  expect(stored(kv, "site").status).toBe("down");
});

test("GET / serves the status page and needs no secret", async () => {
  const { env } = makeRig();
  const res = await worker.fetch(request("GET", "/"), env);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const page = await res.text();
  expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(page.includes("<title>Fleet Canary</title>")).toBe(true);
  expect(page.includes("fetch('/status')")).toBe(true);
  expect(calls).toEqual([]);
});

test("POST /test-alert reports whether Telegram took the message", async () => {
  const sentFor = async (rig: Rig): Promise<unknown> => {
    const res = await worker.fetch(request("POST", "/test-alert", SECRET), rig.env);
    expect(res.status).toBe(200);
    return ((await res.json()) as { sent: unknown }).sent;
  };

  routes.set(TELEGRAM_PREFIX, answerStatus(200));
  expect(await sentFor(makeRig())).toBe(true);
  expect(telegramCalls().length).toBe(1);

  calls = [];
  routes.set(TELEGRAM_PREFIX, answerStatus(400));
  expect(await sentFor(makeRig())).toBe(false);
  expect(telegramCalls().length).toBe(1);

  calls = [];
  routes.set(TELEGRAM_PREFIX, answerThrow);
  expect(await sentFor(makeRig())).toBe(false);
  expect(telegramCalls().length).toBe(1);

  calls = [];
  routes.set(TELEGRAM_PREFIX, answerStatus(200));
  expect(await sentFor(makeRig({ secret: SECRET, chat: CHAT }))).toBe(false);
  expect(await sentFor(makeRig({ secret: SECRET, token: TOKEN }))).toBe(false);
  expect(await sentFor(makeRig({ secret: SECRET }))).toBe(false);
  expect(telegramCalls().length).toBe(0);
});

test("an alert is one POST to sendMessage with the chat id, the text and link previews off", async () => {
  const { env } = makeRig();
  const res = await worker.fetch(request("POST", "/test-alert", SECRET), env);
  expect(res.status).toBe(200);

  const sent = telegramCalls();
  expect(sent.length).toBe(1);
  const call = sent[0];
  expect(call?.url).toBe(TELEGRAM_PREFIX + "bot" + TOKEN + "/sendMessage");
  expect(call?.init?.method).toBe("POST");
  expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(call?.body ?? "null")).toEqual({
    chat_id: CHAT,
    text: "fleet-canary test alert. If you see this, the alert path works.",
    disable_web_page_preview: true,
  });
  const keys = Object.keys(JSON.parse(call?.body ?? "{}") as Record<string, unknown>).sort();
  expect(keys).toEqual(["chat_id", "disable_web_page_preview", "text"]);
});

test("a stored value of the wrong shape is read as unknown", async () => {
  const good = { status: "up", consecutiveFailures: 0, lastCheck: 1 };
  const wrong: unknown[] = [
    "a string",
    42,
    [1, 2],
    { ...good, status: "sideways" },
    { status: "up" },
    { ...good, consecutiveFailures: "0" },
    { ...good, lastCheck: "1" },
    { ...good, lastBeat: "1" },
    { ...good, detail: 7 },
  ];
  const label = target("site").label;

  for (const value of wrong) {
    const { kv, env } = makeRig();
    kv.store.set("state:site", JSON.stringify(value));
    const res = await worker.fetch(request("GET", "/status"), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.site).toEqual({ status: "unknown", consecutiveFailures: 0, lastCheck: 0, label });
  }

  const { kv, env } = makeRig();
  kv.store.set("state:site", JSON.stringify(good));
  const res = await worker.fetch(request("GET", "/status"), env);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.site).toEqual({ ...good, label });
});

// source: a heartbeat that lands while the cron is checking the same machine must not be
// overwritten, and a refused alert must be sent again later

test("a heartbeat that lands during a check is not overwritten", async () => {
  const { kv, env } = makeRig();
  const machine = target("machine");
  if (machine.kind !== "beat") throw new Error("machine is not a beat target");
  const staleBeat = Date.now() - (machine.staleAfterMinutes + 1) * MINUTE;
  const freshBeat = Date.now();
  seed(kv, "site", { status: "up", consecutiveFailures: 0, lastCheck: freshBeat });
  seed(kv, "www", { status: "up", consecutiveFailures: 0, lastCheck: freshBeat });
  seed(kv, "machine", { status: "up", consecutiveFailures: 0, lastCheck: staleBeat, lastBeat: staleBeat });
  const realGet = kv.get.bind(kv);
  let machineReads = 0;
  kv.get = async (key: string, type?: string): Promise<unknown> => {
    if (key === "state:machine") {
      machineReads += 1;
      if (machineReads >= 2) {
        const landed: Stored = { status: "up", consecutiveFailures: 0, lastCheck: freshBeat, lastBeat: freshBeat };
        kv.store.set("state:machine", JSON.stringify(landed));
      }
    }
    return realGet(key, type);
  };

  await runScheduled(env);

  expect(machineReads).toBeGreaterThanOrEqual(2);
  expect(stored(kv, "machine").lastBeat).toBe(freshBeat);
  expect(stored(kv, "machine").status).not.toBe("down");
  expect(messages()).toEqual([]);
});

test("a down alert that Telegram refuses is stored and sent on the next tick", async () => {
  const { kv, env } = makeRig();
  seed(kv, "site", { status: "up", consecutiveFailures: 1, lastCheck: 1 });
  routes.set(SITE_URL, answerStatus(500));
  routes.set(TELEGRAM_PREFIX, answerStatus(500));
  const downText = target("site").label + " is DOWN. HTTP 500 (expected 200)\n\nFix: " + target("site").fix;

  await runScheduled(env);

  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").pendingAlert).toBe(downText);

  calls = [];
  routes.set(TELEGRAM_PREFIX, answerStatus(200));
  await runScheduled(env);

  expect(messages()).toEqual([downText]);
  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").pendingAlert).toBeUndefined();

  calls = [];
  await runScheduled(env);
  expect(messages()).toEqual([]);
});

test("with no Telegram settings a flip stores no pending alert", async () => {
  const { kv, env } = makeRig({ secret: SECRET, chat: CHAT });
  seed(kv, "site", { status: "up", consecutiveFailures: 1, lastCheck: 1 });
  routes.set(SITE_URL, answerStatus(500));

  await runScheduled(env);

  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").pendingAlert).toBeUndefined();
  expect(telegramCalls().length).toBe(0);
});

test("an unchanged target is not written again within the hour", async () => {
  const { kv, env } = makeRig();
  const realNow = Date.now;
  const start = realNow.call(Date);
  try {
    Date.now = (): number => start;
    await runScheduled(env);
    expect(kv.puts.filter((key) => key === "state:site").length).toBe(1);

    Date.now = (): number => start + 5 * MINUTE;
    await runScheduled(env);
    expect(kv.puts.filter((key) => key === "state:site").length).toBe(1);
    expect(kv.puts.filter((key) => key === "state:machine").length).toBe(1);

    Date.now = (): number => start + 60 * MINUTE;
    await runScheduled(env);
    expect(kv.puts.filter((key) => key === "state:site").length).toBe(2);
  } finally {
    Date.now = realNow;
  }
});

// source: a heartbeat stored a state with no pendingAlert, so a back UP text that Telegram had
// refused was erased before any check could send it
test("a heartbeat keeps a pending alert", async () => {
  const { kv, env } = makeRig();
  const label = target("machine").label;
  const upText = label + " is back UP (heartbeat resumed).";
  const freshBeat = Date.now();
  seed(kv, "site", { status: "up", consecutiveFailures: 0, lastCheck: freshBeat });
  seed(kv, "www", { status: "up", consecutiveFailures: 0, lastCheck: freshBeat });
  seed(kv, "machine", {
    status: "up",
    consecutiveFailures: 0,
    lastCheck: freshBeat - MINUTE,
    lastBeat: freshBeat - MINUTE,
    pendingAlert: upText,
  });

  const res = await worker.fetch(request("POST", "/beat?host=machine", SECRET), env);

  expect(res.status).toBe(200);
  expect(stored(kv, "machine").pendingAlert).toBe(upText);
  expect(telegramCalls().length).toBe(0);

  await runScheduled(env);

  expect(messages()).toEqual([upText]);
  expect(stored(kv, "machine").pendingAlert).toBeUndefined();
});

// source: when a pending text was resent and failed again while a newer alert went through, the
// older text stayed stored and was sent after the newer one
test("a newer alert that goes through clears an older pending one", async () => {
  const { kv, env } = makeRig();
  const site = target("site");
  const downText = site.label + " is DOWN. HTTP 500 (expected 200)\n\nFix: " + site.fix;
  const upText = site.label + " is back UP.";
  seed(kv, "site", { status: "down", consecutiveFailures: 2, lastCheck: 1, pendingAlert: downText });
  let sends = 0;
  routes.set(TELEGRAM_PREFIX, () => {
    sends += 1;
    return new Response("stand-in", { status: sends === 1 ? 500 : 200 });
  });

  await runScheduled(env);

  expect(stored(kv, "site").status).toBe("up");
  expect(stored(kv, "site").pendingAlert).toBeUndefined();
  expect(messages()).toEqual([downText, upText]);

  calls = [];
  await runScheduled(env);
  expect(messages()).toEqual([]);
});

// source: the alert text was stored only after a failed send, so a run stopped between the
// write and the send kept the flip and lost the alert
test("a down alert is stored before it is sent", async () => {
  const { kv, env } = makeRig();
  const site = target("site");
  const downText = site.label + " is DOWN. HTTP 500 (expected 200)\n\nFix: " + site.fix;
  seed(kv, "site", { status: "up", consecutiveFailures: 1, lastCheck: 1 });
  routes.set(SITE_URL, answerStatus(500));
  const seenAtSend: (string | undefined)[] = [];
  routes.set(TELEGRAM_PREFIX, () => {
    seenAtSend.push(stored(kv, "site").pendingAlert);
    return new Response("{}", { status: 200 });
  });

  await runScheduled(env);

  expect(seenAtSend).toEqual([downText]);
  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").pendingAlert).toBeUndefined();
});

test("a back UP heartbeat text is stored before it is sent", async () => {
  const { kv, env } = makeRig();
  const upText = target("machine").label + " is back UP (heartbeat resumed).";
  seed(kv, "machine", { status: "down", consecutiveFailures: 1, lastCheck: 1, lastBeat: 1 });
  const seenAtSend: (string | undefined)[] = [];
  routes.set(TELEGRAM_PREFIX, () => {
    seenAtSend.push(stored(kv, "machine").pendingAlert);
    return new Response("{}", { status: 200 });
  });

  const res = await worker.fetch(request("POST", "/beat?host=machine", SECRET), env);

  expect(res.status).toBe(200);
  expect(seenAtSend).toEqual([upText]);
  expect(stored(kv, "machine").status).toBe("up");
  expect(stored(kv, "machine").pendingAlert).toBeUndefined();
});

// source: a resent text that was accepted while a newer heartbeat landed stayed in the
// heartbeat's stored state and was sent again on the next check
test("a resent text is removed even when a newer heartbeat landed during the check", async () => {
  const { kv, env } = makeRig();
  const text = target("machine").label + " is back UP (heartbeat resumed).";
  const base = Date.now() - MINUTE;
  seed(kv, "site", { status: "up", consecutiveFailures: 0, lastCheck: base });
  seed(kv, "www", { status: "up", consecutiveFailures: 0, lastCheck: base });
  seed(kv, "machine", { status: "up", consecutiveFailures: 0, lastCheck: base, lastBeat: base, pendingAlert: text });
  routes.set(TELEGRAM_PREFIX, () => {
    const landed: Stored = {
      status: "up",
      consecutiveFailures: 0,
      lastCheck: base + 1000,
      lastBeat: base + 1000,
      pendingAlert: text,
    };
    kv.store.set("state:machine", JSON.stringify(landed));
    return new Response("{}", { status: 200 });
  });

  await runScheduled(env);

  expect(messages()).toEqual([text]);
  expect(stored(kv, "machine").lastBeat).toBe(base + 1000);
  expect(stored(kv, "machine").pendingAlert).toBeUndefined();

  calls = [];
  await runScheduled(env);
  expect(messages()).toEqual([]);
});

test("with Telegram unset, a flip is written once", async () => {
  const { kv, env } = makeRig({});
  seed(kv, "site", { status: "up", consecutiveFailures: 1, lastCheck: 1 });
  routes.set(SITE_URL, answerStatus(500));

  await runScheduled(env);

  expect(kv.puts.filter((key) => key === "state:site").length).toBe(1);
  expect(stored(kv, "site").status).toBe("down");
  expect(stored(kv, "site").pendingAlert).toBeUndefined();
  expect(telegramCalls().length).toBe(0);
});
