import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// source: beat.sh is run only against a server this file opens on 127.0.0.1, and every run either
// sets CANARY_HOST or has a stand-in hostname program first on PATH

const SCRIPT = join(import.meta.dir, "..", "beat.sh");
const SECRET = "example-secret";

interface Seen {
  method: string;
  path: string;
  query: string;
  secret: string | null;
}

interface Outcome {
  code: number;
  stderr: string;
  seen: Seen[];
}

interface Run {
  env: Record<string, string>;
  answer?: number;
  serve?: boolean;
  url?: (origin: string) => string;
}

async function withStandIn<T>(body: (folder: string) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "beat-test-"));
  try {
    const program = join(folder, "hostname");
    writeFileSync(program, "#!/bin/sh\necho stand-in-host\n");
    chmodSync(program, 0o755);
    return await body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function runBeat(run: Run): Promise<Outcome> {
  return withStandIn(async (folder) => {
    const seen: Seen[] = [];
    const server =
      run.serve === false
        ? null
        : Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req: Request): Response {
              const url = new URL(req.url);
              seen.push({
                method: req.method,
                path: url.pathname,
                query: url.search.replace(/^\?/, ""),
                secret: req.headers.get("x-canary-secret"),
              });
              return new Response("stand-in", { status: run.answer ?? 200 });
            },
          });
    try {
      const origin = "http://127.0.0.1:" + (server ? server.port : 0);
      const env: Record<string, string> = { PATH: folder + ":/usr/bin:/bin" };
      for (const [key, value] of Object.entries(run.env)) env[key] = value;
      if (run.url) env.CANARY_URL = run.url(origin);
      const child = Bun.spawn(["/bin/bash", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(child.stderr).text();
      const code = await child.exited;
      return { code, stderr, seen };
    } finally {
      if (server) server.stop(true);
    }
  });
}

test("beat.sh exits 2 and names the variable when CANARY_URL or CANARY_SECRET is unset", async () => {
  const noUrl = await runBeat({ env: { CANARY_SECRET: SECRET, CANARY_HOST: "machine" } });
  expect(noUrl.code).toBe(2);
  expect(noUrl.stderr).toContain("CANARY_URL is unset");
  expect(noUrl.seen).toEqual([]);

  const noSecret = await runBeat({ env: { CANARY_HOST: "machine" }, url: (origin) => origin });
  expect(noSecret.code).toBe(2);
  expect(noSecret.stderr).toContain("CANARY_SECRET is unset");
  expect(noSecret.seen).toEqual([]);
});

test("beat.sh posts the host and the secret and exits 0 on a 200", async () => {
  const outcome = await runBeat({
    env: { CANARY_SECRET: SECRET, CANARY_HOST: "machine" },
    url: (origin) => origin,
  });

  expect(outcome.code).toBe(0);
  expect(outcome.stderr).toBe("");
  expect(outcome.seen).toEqual([{ method: "POST", path: "/beat", query: "host=machine", secret: SECRET }]);
});

test("beat.sh exits 1 and names the status when the answer is not 200", async () => {
  const outcome = await runBeat({
    env: { CANARY_SECRET: SECRET, CANARY_HOST: "machine" },
    answer: 401,
    url: (origin) => origin,
  });

  expect(outcome.code).toBe(1);
  expect(outcome.stderr).toContain("HTTP 401");
  expect(outcome.stderr).toContain("machine");
  expect(outcome.seen.length).toBe(1);
});

test("beat.sh exits 1 with HTTP 000 when nothing answers", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const deadOrigin = "http://127.0.0.1:" + closed.port;
  closed.stop(true);

  const outcome = await runBeat({
    env: { CANARY_SECRET: SECRET, CANARY_HOST: "machine", CANARY_URL: deadOrigin },
    serve: false,
  });

  expect(outcome.code).toBe(1);
  expect(outcome.stderr).toContain("HTTP 000");
  expect(outcome.seen).toEqual([]);
});

test("beat.sh uses the short hostname when CANARY_HOST is unset", async () => {
  const outcome = await runBeat({
    env: { CANARY_SECRET: SECRET },
    url: (origin) => origin,
  });

  expect(outcome.code).toBe(0);
  expect(outcome.seen.length).toBe(1);
  expect(outcome.seen[0]?.query === "host=stand-in-host").toBe(true);
});

test("beat.sh refuses a host with a space and sends nothing", async () => {
  const outcome = await runBeat({
    env: { CANARY_SECRET: SECRET, CANARY_HOST: "a b" },
    url: (origin) => origin,
  });

  expect(outcome.code).toBe(2);
  expect(outcome.stderr).toContain("may hold only letters");
  expect(outcome.seen).toEqual([]);
});
