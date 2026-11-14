// source: breaking each line named below must turn the named test red in a temporary copy
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SourceFile = "src/decide.ts" | "src/index.ts" | "beat.sh";
type TestFile = "tests/decide.test.ts" | "tests/worker.test.ts" | "tests/beat.test.ts";

interface Mutation {
  name: string;
  file: SourceFile;
  testFile: TestFile;
  test: string;
  from: string;
  to: string;
}

const DECIDE: SourceFile = "src/decide.ts";
const INDEX: SourceFile = "src/index.ts";
const DECIDE_TESTS: TestFile = "tests/decide.test.ts";
const WORKER_TESTS: TestFile = "tests/worker.test.ts";
const BEAT_TESTS: TestFile = "tests/beat.test.ts";
const BEAT_SH: SourceFile = "beat.sh";

const BEAT_CHECK = "Promise<Response> {\n  if (!beatAuthorized(";
const RUN_CHECK = 'if (url.pathname === "/run" && request.method === "POST") {\n      if (!beatAuthorized(';
const ALERT_CHECK = 'if (url.pathname === "/test-alert" && request.method === "POST") {\n      if (!beatAuthorized(';

const mutations: Mutation[] = [
  {
    name: "first sight counts as seen before",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "first sight of a target",
    from: 'const seenBefore = input.prev.status !== "unknown";',
    to: "const seenBefore = true;",
  },
  {
    name: "threshold needs one failure more",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "up to down flips after two failures and not after one",
    from: "const enough = failures >= input.threshold;",
    to: "const enough = failures > input.threshold;",
  },
  {
    name: "a healthy check on a down target reports down",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "down to up flips at once",
    from: 'if (healthy) return "up";',
    to: 'if (healthy) return "down";',
  },
  {
    name: "flip detection inverted",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "no alert when the state is unchanged",
    from: "const flipped = effective !== input.prev.status;",
    to: "const flipped = effective === input.prev.status;",
  },
  {
    name: "a beat at the limit counts as stale",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "a heartbeat inside its limit is up",
    from: "const withinLimit = ageMin <= staleAfterMinutes;",
    to: "const withinLimit = ageMin < staleAfterMinutes;",
  },
  {
    name: "a stale beat counts as healthy",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "a stale heartbeat is down",
    from: "const staleHealthy = false;",
    to: "const staleHealthy = true;",
  },
  {
    name: "a never-seen host is marked down",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "a host never heard from is unknown and raises no down alert",
    from: 'const unseenStatus: Status = "unknown";',
    to: 'const unseenStatus: Status = "down";',
  },
  {
    name: "secret comparison inverted",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "a missing or wrong secret on /beat is refused",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = !(header !== null && sameSecret(header, secret));",
  },
  {
    name: "secret check on /beat removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /beat without the secret is refused with 401 and stores nothing",
    from: BEAT_CHECK,
    to: "Promise<Response> {\n  if (false && !beatAuthorized(",
  },
  {
    name: "secret check on /beat removed (wrong secret)",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /beat with a wrong secret is refused with 401",
    from: BEAT_CHECK,
    to: "Promise<Response> {\n  if (false && !beatAuthorized(",
  },
  {
    name: "empty-secret guard removed",
    file: DECIDE,
    testFile: WORKER_TESTS,
    test: "POST /beat is refused with 401 when no secret is configured, even with a header",
    from: "if (secret === undefined || secret.length === 0) return false;",
    to: "",
  },
  {
    name: "secret check on /run removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /run without the secret is refused with 401 and makes no outbound request",
    from: RUN_CHECK,
    to: 'if (url.pathname === "/run" && request.method === "POST") {\n      if (false && !beatAuthorized(',
  },
  {
    name: "secret check on /test-alert removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /test-alert without the secret is refused with 401 and makes no outbound request",
    from: ALERT_CHECK,
    to: 'if (url.pathname === "/test-alert" && request.method === "POST") {\n      if (false && !beatAuthorized(',
  },
  {
    name: "unknown host answer on /beat removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /beat for an unknown host is refused with 400 and stores nothing",
    from: 'if (!host || !target) return Response.json({ error: "unknown host" }, { status: 400 });',
    to: "",
  },
  {
    name: "recordBeat stores a beat time of 0",
    file: DECIDE,
    testFile: WORKER_TESTS,
    test: "POST /beat with the secret stores the beat time for that host and marks it up",
    from: "lastBeat: now,",
    to: "lastBeat: 0,",
  },
  {
    name: "recordBeat stores a beat time of 0 (unit)",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "recordBeat stores the beat time and marks the host up",
    from: "lastBeat: now,",
    to: "lastBeat: 0,",
  },
  {
    name: "recordBeat never raises the up alert",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "recordBeat on a host that was down raises an up alert",
    from: "    alert: decision.alert,\n    change: decision.change,\n  };\n}\n\nfunction beatResult",
    to: "    alert: null,\n    change: decision.change,\n  };\n}\n\nfunction beatResult",
  },
  {
    name: "resolveBeatHost accepts an unlisted id",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "resolveBeatHost accepts a listed id, trims spaces around it and refuses any other",
    from: "if (!ids.includes(host)) return null;",
    to: "if (false) return null;",
  },
  {
    name: "resolveBeatHost stops trimming",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "resolveBeatHost accepts a listed id, trims spaces around it and refuses any other",
    from: "const host = rawHost.trim();",
    to: "const host = rawHost;",
  },
  {
    name: "interpretHttp treats an unlisted status as healthy",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "interpretHttp treats a listed status as healthy and names the status it got otherwise",
    from: "if (expect.includes(status)) return { healthy: true };",
    to: "if (true) return { healthy: true };",
  },
  {
    name: "interpretHttp names the wrong list",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "interpretHttp treats a listed status as healthy and names the status it got otherwise",
    from: 'expect.join("/")',
    to: 'expect.join(",")',
  },
  {
    name: "interpretHttpError reports healthy",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "interpretHttpError is unhealthy and carries the message",
    from: 'return { healthy: false, detail: "fetch failed: " + message };',
    to: 'return { healthy: true, detail: "fetch failed: " + message };',
  },
  {
    name: "interpretHttpError drops the message",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "interpretHttpError is unhealthy and carries the message",
    from: 'detail: "fetch failed: " + message',
    to: 'detail: "fetch failed: "',
  },
  {
    name: "the scheduled run alerts when nothing flipped",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a site that fails twice in a row raises exactly one down alert, on the second failure, and none on the third",
    from: '} else if (decision.alert === "up") {\n      message = target.label + " is back UP.";',
    to: '} else {\n      message = target.label + " is back UP.";',
  },
  {
    name: "the alert is sent although the Telegram settings are missing",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "with the Telegram settings missing a flip sends nothing and the new state is still stored",
    from: 'if (!telegramReady(env)) return "skipped";',
    to: 'if (false) return "skipped";',
  },
  {
    name: "one missing Telegram setting is tolerated",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "with the Telegram settings missing a flip sends nothing and the new state is still stored",
    from: 'if (!telegramReady(env)) return "skipped";',
    to: 'if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID) return "skipped";',
  },
  {
    name: "the baseline run alerts on first sight",
    file: DECIDE,
    testFile: WORKER_TESTS,
    test: "a first scheduled run stores a baseline for each site and sends no alert",
    from: 'const seenBefore = input.prev.status !== "unknown";',
    to: "const seenBefore = true;",
  },
  {
    name: "the new state is not stored after a flip",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a site that comes back raises exactly one up alert",
    from: "await env.CANARY.put(STATE_PREFIX + id, JSON.stringify(state));",
    to: "void state;",
  },
  {
    name: "the health count is wrong",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "GET /health needs no secret and reports the target count",
    from: "targets: TARGETS.length",
    to: "targets: 0",
  },
  {
    name: "an unknown path answers 200",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "an unknown path gets 404",
    from: 'new Response("Not found", { status: 404 })',
    to: 'new Response("Not found", { status: 200 })',
  },
  {
    name: "the heartbeat recovery alert drops the label",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "every alert text that was sent names the target's label, says DOWN or UP, and holds only ASCII characters",
    from: 'target.label + " is back UP (heartbeat resumed)."',
    to: '"The host is back UP (heartbeat resumed)."',
  },
  {
    name: "the down alert carries a pictograph",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "every alert text that was sent names the target's label, says DOWN or UP, and holds only ASCII characters",
    from: 'message = target.label + " is DOWN. "',
    to: 'message = "\\u{1F534} " + target.label + " is DOWN. "',
  },
  {
    name: "the test alert carries a pictograph",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /test-alert with the secret sends the fixed alert text",
    from: '"fleet-canary test alert.',
    to: '"\\u{1F9EA} fleet-canary test alert.',
  },
  {
    name: "the URL check follows redirects",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a URL check is sent with redirect manual, the fleet-canary user agent and a 12000 millisecond timeout",
    from: "redirect: \"manual\",",
    to: "redirect: \"follow\",",
  },
  {
    name: "the URL check has no timeout",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a URL check is sent with redirect manual, the fleet-canary user agent and a 12000 millisecond timeout",
    from: "      signal: AbortSignal.timeout(12000),\n    });\n    return interpretHttp(",
    to: "    });\n    return interpretHttp(",
  },
  {
    name: "the URL check timeout is 1200",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a URL check is sent with redirect manual, the fleet-canary user agent and a 12000 millisecond timeout",
    from: "AbortSignal.timeout(12000),\n    });\n    return interpretHttp(",
    to: "AbortSignal.timeout(1200),\n    });\n    return interpretHttp(",
  },
  {
    name: "the URL check sends another user agent",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a URL check is sent with redirect manual, the fleet-canary user agent and a 12000 millisecond timeout",
    from: "\"user-agent\": \"fleet-canary (Cloudflare Worker)\"",
    to: "\"user-agent\": \"curl/8\"",
  },
  {
    name: "an alert send that throws stops the run",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "an alert send that throws does not stop the run",
    from: '    // Alerting must never take the check loop down with it.\n    return "failed";',
    to: "    // Alerting must never take the check loop down with it.\n    throw new Error(\"alert failed\");",
  },
  {
    name: "GET / route removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "GET / serves the status page and needs no secret",
    from: "if (url.pathname === \"/\") return new Response(renderPage(), {",
    to: "if (false) return new Response(renderPage(), {",
  },
  {
    name: "/test-alert answers sent true",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /test-alert reports whether Telegram took the message",
    from: 'return Response.json({ sent: outcome === "sent" });',
    to: "return Response.json({ sent: true });",
  },
  {
    name: "the alert function returns true instead of res.ok",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "POST /test-alert reports whether Telegram took the message",
    from: 'return res.ok ? "sent" : "failed";',
    to: 'return "sent";',
  },
  {
    name: "chat_id dropped from the alert body",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "an alert is one POST to sendMessage with the chat id, the text and link previews off",
    from: "chat_id: chat, text: message",
    to: "text: message",
  },
  {
    name: "disable_web_page_preview dropped from the alert body",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "an alert is one POST to sendMessage with the chat id, the text and link previews off",
    from: "text: message, disable_web_page_preview: true",
    to: "text: message",
  },
  {
    name: "the shape check is a plain object check",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "if (isTargetState(raw)) return raw;",
    to: "if (isRecord(raw)) return raw as unknown as TargetState;",
  },
  {
    name: "the status rule in isTargetState removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "  if (status !== \"up\" && status !== \"down\" && status !== \"unknown\") return false;\n",
    to: "",
  },
  {
    name: "the consecutiveFailures rule in isTargetState removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "  if (typeof raw.consecutiveFailures !== \"number\") return false;\n",
    to: "",
  },
  {
    name: "the lastCheck rule in isTargetState removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "  if (typeof raw.lastCheck !== \"number\") return false;\n",
    to: "",
  },
  {
    name: "the lastBeat rule in isTargetState removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "  if (raw.lastBeat !== undefined && typeof raw.lastBeat !== \"number\") return false;\n",
    to: "",
  },
  {
    name: "the detail rule in isTargetState removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a stored value of the wrong shape is read as unknown",
    from: "  if (raw.detail !== undefined && typeof raw.detail !== \"string\") return false;\n",
    to: "",
  },
  {
    name: "the heartbeat age is rounded up",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "heartbeat age is counted in whole minutes, rounded down",
    from: "const ageMin = Math.floor((now - lastBeat) / 60000);",
    to: "const ageMin = Math.ceil((now - lastBeat) / 60000);",
  },
  {
    name: "a header that only starts with the secret is accepted",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "beatAuthorized accepts the exact secret and nothing near it",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = header !== null && header.startsWith(secret);",
  },
  {
    name: "a secret that only starts with the header is accepted",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "beatAuthorized accepts the exact secret and nothing near it",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = header !== null && secret.startsWith(header);",
  },
  {
    name: "the secret is compared without regard to case",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "beatAuthorized accepts the exact secret and nothing near it",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = header !== null && sameSecret(header.toLowerCase(), secret.toLowerCase());",
  },
  {
    name: "the header is trimmed before the comparison",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "beatAuthorized accepts the exact secret and nothing near it",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = header !== null && sameSecret(header.trim(), secret);",
  },
  {
    name: "a longer, shorter or other-case secret is accepted on the routes",
    file: DECIDE,
    testFile: WORKER_TESTS,
    test: "POST /beat, /run and /test-alert refuse a secret that is longer, shorter or in another case",
    from: "const matches = header !== null && sameSecret(header, secret);",
    to: "const matches = header !== null && secret.startsWith(header.toLowerCase());",
  },
  {
    name: "sameSecret drops the byte comparison",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "sameSecret is true only when every byte matches",
    from: "    difference |= (bytesA[index] ?? 0) ^ (bytesB[index] ?? 0);\n",
    to: "",
  },
  {
    name: "sameSecret does not count the lengths",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "sameSecret is true only when every byte matches",
    from: "let difference = bytesA.length ^ bytesB.length;",
    to: "let difference = 0;",
  },
  {
    name: "sameSecret answers true",
    file: DECIDE,
    testFile: DECIDE_TESTS,
    test: "sameSecret is true only when every byte matches",
    from: "return difference === 0;",
    to: "return true;",
  },
  {
    name: "beat.sh does not check CANARY_URL",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh exits 2 and names the variable when CANARY_URL or CANARY_SECRET is unset",
    from: "if [ -z \"${CANARY_URL:-}\" ]; then",
    to: "if false; then",
  },
  {
    name: "beat.sh does not check CANARY_SECRET",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh exits 2 and names the variable when CANARY_URL or CANARY_SECRET is unset",
    from: "if [ -z \"${CANARY_SECRET:-}\" ]; then",
    to: "if false; then",
  },
  {
    name: "beat.sh exits 0 after a failed post",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh exits 1 and names the status when the answer is not 200",
    from: ">&2\nexit 1\n",
    to: ">&2\nexit 0\n",
  },
  {
    name: "beat.sh exits 0 when nothing answers",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh exits 1 with HTTP 000 when nothing answers",
    from: ">&2\nexit 1\n",
    to: ">&2\nexit 0\n",
  },
  {
    name: "beat.sh sends no secret header",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh posts the host and the secret and exits 0 on a 200",
    from: "  -H \"x-canary-secret: ${CANARY_SECRET}\" 2>/dev/null)\"",
    to: "  2>/dev/null)\"",
  },
  {
    name: "beat.sh leaves the host out of the query",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh posts the host and the secret and exits 0 on a 200",
    from: "/beat?host=${HOST}\"",
    to: "/beat\"",
  },
  {
    name: "beat.sh ignores CANARY_HOST",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh posts the host and the secret and exits 0 on a 200",
    from: "HOST=\"${CANARY_HOST:-$(hostname -s)}\"",
    to: "HOST=\"$(hostname -s)\"",
  },
  {
    name: "the fresh-read check before a write is removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a heartbeat that lands during a check is not overwritten",
    from: "if (await newerBeatLanded(env, target, prev)) {",
    to: "if (false) {",
  },
  {
    name: "a refused alert is not kept as pendingAlert",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a down alert that Telegram refuses is stored and sent on the next tick",
    from: 'if (outcome !== "failed" && stored === message) await clearPending(env, target.id, message);',
    to: 'if (stored === message) await clearPending(env, target.id, message);',
  },
  {
    name: "the kept pendingAlert is never sent again",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a down alert that Telegram refuses is stored and sent on the next tick",
    from: "const resent = await alert(env, pending);",
    to: "const resent: AlertOutcome = \"sent\";",
  },
  {
    name: "a skipped send is treated as failed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "with no Telegram settings a flip stores no pending alert",
    from: "const stored = message !== null ? (telegramReady(env) ? message : undefined) : pending;\n    const decided = withPending(decision.state, stored);\n    if (needsWrite(prev, decided, now)) {\n      if (await newerBeatLanded(env, target, prev)) {\n        if (prev.pendingAlert !== undefined && pending === undefined) {\n          await clearPending(env, target.id, prev.pendingAlert);\n        }\n        continue;\n      }\n      await writeState(env, target.id, decided);\n    }\n\n    if (decision.change) changes.push(decision.change);\n\n    if (message !== null) {\n      const outcome = await alert(env, message);\n      if (outcome !== \"failed\" && stored === message) await clearPending(env, target.id, message);",
    to: "const stored = message !== null ? message : pending;\n    const decided = withPending(decision.state, stored);\n    if (needsWrite(prev, decided, now)) {\n      if (await newerBeatLanded(env, target, prev)) {\n        if (prev.pendingAlert !== undefined && pending === undefined) {\n          await clearPending(env, target.id, prev.pendingAlert);\n        }\n        continue;\n      }\n      await writeState(env, target.id, decided);\n    }\n\n    if (decision.change) changes.push(decision.change);\n\n    if (message !== null) {\n      const outcome = await alert(env, message);\n      if (outcome === \"sent\" && stored === message) await clearPending(env, target.id, message);",
  },
  {
    name: "every check writes every target",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "an unchanged target is not written again within the hour",
    from: "if (needsWrite(prev, decided, now)) {",
    to: "if (true) {",
  },
  {
    name: "beat.sh accepts any host",
    file: BEAT_SH,
    testFile: BEAT_TESTS,
    test: "beat.sh refuses a host with a space and sends nothing",
    from: "if ! plain_host \"$HOST\"; then",
    to: "if false; then",
  },
  {
    name: "a heartbeat drops a pending alert",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a heartbeat keeps a pending alert",
    from: ": prev.pendingAlert;",
    to: ": undefined;",
  },
  {
    name: "a newer alert leaves an older pending one stored",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a newer alert that goes through clears an older pending one",
    from: "const decided = withPending(decision.state, stored);",
    to: "const decided = withPending(decision.state, pending);",
  },
  {
    name: "the down alert text is not stored before the send",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a down alert is stored before it is sent",
    from: "(telegramReady(env) ? message : undefined)",
    to: "undefined",
  },
  {
    name: "the up alert text is not stored before the send",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a back UP heartbeat text is stored before it is sent",
    from: "(telegramReady(env) ? upText : undefined)",
    to: "undefined",
  },
  {
    name: "a text that was resent is kept when a newer heartbeat landed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a resent text is removed even when a newer heartbeat landed during the check",
    from: "await clearPending(env, target.id, prev.pendingAlert);",
    to: "",
  },
  {
    name: "an accepted alert text is never removed",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "a down alert is stored before it is sent",
    from: "if (outcome !== \"failed\" && stored === message) await clearPending(env, target.id, message);",
    to: "",
  },
  {
    name: "Telegram counts as set up whatever is configured",
    file: INDEX,
    testFile: WORKER_TESTS,
    test: "with Telegram unset, a flip is written once",
    from: "return Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(env.TELEGRAM_CHAT_ID);",
    to: "return true;",
  },
];

const projectRoot = join(import.meta.dir, "..");

let survived = 0;

for (const mutation of mutations) {
  const original = readFileSync(join(projectRoot, mutation.file), "utf8");
  const copies = original.split(mutation.from).length - 1;
  if (copies !== 1) {
    console.log("survived: " + describe(mutation) + " (from text matched " + copies + " times)");
    survived += 1;
    continue;
  }

  const root = mkdtempSync(join(tmpdir(), "fleet-canary-mutate-"));
  try {
    cpSync(join(projectRoot, "src"), join(root, "src"), { recursive: true });
    cpSync(join(projectRoot, "tests"), join(root, "tests"), { recursive: true });
    copyFileSync(join(projectRoot, "beat.sh"), join(root, "beat.sh"));
    chmodSync(join(root, "beat.sh"), 0o755);
    writeFileSync(join(root, "package.json"), '{ "type": "module", "name": "fleet-canary-mutate" }\n');
    const mutated = original.split(mutation.from).join(mutation.to);
    writeFileSync(join(root, mutation.file), mutated);

    const ran = spawnSync("bun", ["test", join(root, mutation.testFile)], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const output = (ran.stdout || "") + "\n" + (ran.stderr || "");
    const outcome = namedResult(output, mutation.test);
    if (outcome === "fail") {
      console.log("killed: " + describe(mutation));
    } else {
      console.log("survived: " + describe(mutation) + " (named test " + outcome + ")");
      survived += 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(mutations.length - survived + " killed, " + survived + " survived");
process.exit(survived === 0 ? 0 : 1);

function describe(mutation: Mutation): string {
  return mutation.name + " [" + mutation.file + " | " + mutation.testFile + " | " + mutation.test + "]";
}

function namedResult(output: string, name: string): "pass" | "fail" | "missing" {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  let found: "pass" | "fail" | "missing" = "missing";
  for (const line of plain.split(/\r?\n/)) {
    const text = line.trim();
    const kind = text.startsWith("(fail) ") ? "fail" : text.startsWith("(pass) ") ? "pass" : null;
    if (kind === null) continue;
    const rest = text.slice("(fail) ".length);
    if (rest !== name && !rest.startsWith(name + " [")) continue;
    if (kind === "fail") found = "fail";
    else if (found !== "fail") found = "pass";
  }
  return found;
}
