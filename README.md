# fleet-canary

fleet-canary is a Cloudflare Worker that checks the URLs you configure and records heartbeats from machines. It sends a Telegram message only when a target flips between up and down, and it leaves a machine that has never reported as unknown. It is meant for someone who wants those checks to run from the edge, to try them locally with no Cloudflare account, and then to deploy the same Worker against their own targets.

## Quick start

This needs Bun, Node.js 22 or newer, and curl. Wrangler, which runs the local server, needs Node.js: under Bun alone the server starts but answers every request with 503.

From a fresh clone, install, test, and typecheck:

```bash
bun install
```

```bash
bun test
```

```bash
bun run typecheck
```

Copy the example secrets so the local heartbeat uses the same placeholder the curl below sends. `.dev.vars` is listed in `.gitignore`.

```bash
cp .dev.vars.example .dev.vars
```

In one terminal, start the local server. `bun run dev` runs `wrangler dev --test-scheduled`. On Node.js 26 with wrangler 4.158.0 it printed `Ready on http://localhost:8787` and did not ask for a Cloudflare login.

```bash
bun run dev
```

In another terminal, fire the scheduled handler:

```bash
curl -sS "http://localhost:8787/__scheduled"
```

Read the state and the health check:

```bash
curl -sS "http://localhost:8787/status"
```

```bash
curl -sS "http://localhost:8787/health"
```

Post a heartbeat for the example machine id:

```bash
curl -sS -X POST "http://localhost:8787/beat?host=machine" -H "x-canary-secret: replace-with-shared-secret"
```

Read the state again to see the heartbeat:

```bash
curl -sS "http://localhost:8787/status"
```

## Example

These are the bodies from that local run. The scheduled response is returned while `ctx.waitUntil` is still finishing the checks, so the status below is from a later request, after the three targets had been written.

```text
Ran scheduled event
```

```text
{"site":{"status":"up","consecutiveFailures":0,"lastCheck":1794607217898,"label":"example.com"},"www":{"status":"up","consecutiveFailures":0,"lastCheck":1794607218002,"label":"www.example.com"},"machine":{"status":"unknown","consecutiveFailures":0,"lastCheck":1794607218096,"detail":"never reported a heartbeat","label":"machine"}}
```

```text
{"ok":true,"targets":3}
```

```text
{"ok":true,"host":"machine","at":1794607220084}
```

```text
{"site":{"status":"up","consecutiveFailures":0,"lastCheck":1794607217898,"label":"example.com"},"www":{"status":"up","consecutiveFailures":0,"lastCheck":1794607218002,"label":"www.example.com"},"machine":{"status":"up","consecutiveFailures":0,"lastCheck":1794607220084,"lastBeat":1794607220084,"label":"machine"}}
```

The first JSON is `GET /status`. The second is `GET /health`. The third is the heartbeat response. The fourth is `GET /status` after the heartbeat.

## Deploy

Create a KV namespace, then replace the placeholder id `00000000000000000000000000000000` in `wrangler.jsonc` with the id from that command. The binding name is `CANARY`.

```bash
bunx wrangler kv namespace create CANARY
```

Set the three secrets the Worker reads. The names match `.dev.vars.example`.

```bash
bunx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
bunx wrangler secret put TELEGRAM_CHAT_ID
```

```bash
bunx wrangler secret put BEAT_SECRET
```

Deploy:

```bash
bun run deploy
```

On each machine, run `beat.sh` from cron or launchd. Export `CANARY_URL` (the Worker origin) and `CANARY_SECRET` (the same value as `BEAT_SECRET`). `CANARY_HOST` is optional and defaults to the short hostname. Set it when that short name is not the beat target id in `src/config.ts`. The example id is `machine`.

## How it works

`wrangler.jsonc` schedules the Worker with `*/5 * * * *`. Each run loads the previous state from the `CANARY` KV namespace. Keys are `state:` plus the target id. A missing key is treated as `unknown` with `consecutiveFailures` 0 and `lastCheck` 0. A stored value that is not a state record is treated the same way.

An `http` target is fetched with `redirect` set to `manual`, a 12000 millisecond timeout, and the user agent `fleet-canary (Cloudflare Worker)`. The check is healthy when the status is in the target's `expect` list. The example site expects 200. The example `www` target expects 200, 302, or 307. `failuresBeforeAlert` on both example URL targets is 2. A target that is up stays up after one failure. The second failure in a row stores `down` and alerts. One healthy check stores `up`, clears the failure count, and alerts if the previous status was `down`.

A `beat` target with no `lastBeat` is stored as `unknown` with the detail `never reported a heartbeat`, and it does not alert. `POST /beat?host=<id>` with the header `x-canary-secret` records `lastBeat`. A missing secret, an empty secret, or a header that does not match returns 401 and the body `unauthorized`. The comparison reads every byte of both values before it answers, and only the exact secret matches: a longer value, a shorter one or another case is refused. An id that is not a beat target returns 400 and `{"error":"unknown host"}`. On a later check, the age in whole minutes is `Math.floor((now - lastBeat) / 60000)`. The host is up when that age is less than or equal to `staleAfterMinutes`. The example machine uses 30. One stale check is enough to store `down` and alert, because a beat target uses a failure threshold of 1. A heartbeat that arrives while the host is `down` alerts that it is back up.

Alerts fire only when the new status differs from the previous status and the previous status was not `unknown`. The same status on the next check does not alert. The down message includes the detail and the target's `fix` line. The scheduled recovery message says the target is back up. The heartbeat recovery message says the heartbeat resumed. If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing, the send is skipped and the checks continue.

`GET /` is an HTML status page. `GET /status` is the same state as JSON. `GET /health` returns `{"ok":true,"targets":3}` with the example config. `POST /run` with the secret runs the same checks as the cron and returns the change list. `POST /test-alert` with the secret sends one fixed Telegram message.

## Limits

In the local run, `/__scheduled` returned `Ran scheduled event` before every target had been written. The handler passes the checks to `ctx.waitUntil`, so a status read that overlaps the run can show a mix of new and old rows.

The HTML page and `GET /status` do not check the secret. A fresh URL failure is stored as `up` until the failure count reaches `failuresBeforeAlert`, and that first sight does not alert. A machine that has never sent a heartbeat stays `unknown` and does not raise a down alert. Heartbeat age is whole minutes, so a beat slightly over the limit can still count as inside it until the next full minute.

`beat.sh` needs `curl`. It exits 2 with an error on stderr when `CANARY_URL` or `CANARY_SECRET` is unset. A non-200 response exits 1. The local server runs only while `bun run dev` is running. The cron in `wrangler.jsonc` is what runs the checks after deploy.

## Where this came from

It was built in August 2026 to watch its author's own sites and machines. The published copy ships the example targets in `src/config.ts`.

## License

The project is licensed under the MIT license. See `LICENSE`.

## Built at San Diego AI Studio

This tool comes out of San Diego AI Studio, the builders' community in San Diego. The project list is at https://sandiegoaistudio.com/projects.
