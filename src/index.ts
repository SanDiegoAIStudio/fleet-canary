import { TARGETS, type Target } from "./config";
import {
  beatAuthorized,
  decideScheduled,
  resolveBeatHost,
  emptyState,
  interpretHttp,
  interpretHttpError,
  recordBeat,
  type CheckResult,
  type TargetState,
} from "./decide";

export interface Env {
  CANARY: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  BEAT_SECRET?: string;
}

const STATE_PREFIX = "state:";
const HOUR = 60 * 60 * 1000;

type AlertOutcome = "sent" | "skipped" | "failed";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/beat" && request.method === "POST") {
      return handleBeat(request, env, url);
    }

    if (url.pathname === "/status") {
      return Response.json(await readAll(env));
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, targets: TARGETS.length });
    }

    // Manual trigger, same code path as the cron.
    if (url.pathname === "/run" && request.method === "POST") {
      if (!beatAuthorized(request.headers.get("x-canary-secret"), env.BEAT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const changes = await runChecks(env);
      return Response.json({ ran: true, changes });
    }

    // Proves the alert path end to end.
    if (url.pathname === "/test-alert" && request.method === "POST") {
      if (!beatAuthorized(request.headers.get("x-canary-secret"), env.BEAT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const outcome = await alert(env, "fleet-canary test alert. If you see this, the alert path works.");
      return Response.json({ sent: outcome === "sent" });
    }

    if (url.pathname === "/") return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runChecks(env));
  },
} satisfies ExportedHandler<Env>;

async function handleBeat(request: Request, env: Env, url: URL): Promise<Response> {
  if (!beatAuthorized(request.headers.get("x-canary-secret"), env.BEAT_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const beatIds = TARGETS.flatMap((candidate) => (candidate.kind === "beat" ? [candidate.id] : []));
  const host = resolveBeatHost(url.searchParams.get("host") || "", beatIds);
  const target = TARGETS.find((candidate) => candidate.id === host && candidate.kind === "beat");
  if (!host || !target) return Response.json({ error: "unknown host" }, { status: 400 });

  const prev = await readState(env, host);
  const now = Date.now();
  const decision = recordBeat(prev, now);
  // A host that beats after being marked down is a recovery worth announcing. The text is
  // stored with the state before it is sent, so a run that stops in between loses nothing.
  // A heartbeat that raises no alert leaves a text stored earlier in place.
  const upText = decision.alert === "up" ? target.label + " is back UP (heartbeat resumed)." : undefined;
  const stored = decision.alert === "up" ? (telegramReady(env) ? upText : undefined) : prev.pendingAlert;
  await writeState(env, host, withPending(decision.state, stored));

  if (upText !== undefined) {
    const upOutcome = await alert(env, upText);
    if (upOutcome !== "failed" && stored === upText) await clearPending(env, host, upText);
  }

  return Response.json({ ok: true, host, at: now });
}

async function runChecks(env: Env): Promise<string[]> {
  const changes: string[] = [];

  for (const target of TARGETS) {
    const prev = await readState(env, target.id);

    // A stored alert text goes out first: Telegram refused it, or a run stopped before sending it.
    let pending = prev.pendingAlert;
    if (pending !== undefined) {
      const resent = await alert(env, pending);
      if (resent !== "failed") pending = undefined;
    }

    const now = Date.now();
    const decision = target.kind === "http"
      ? decideScheduled({
          id: target.id,
          kind: "http",
          prev,
          now,
          httpResult: await checkHttp(target),
          failuresBeforeAlert: target.failuresBeforeAlert,
        })
      : decideScheduled({
          id: target.id,
          kind: "beat",
          prev,
          now,
          staleAfterMinutes: target.staleAfterMinutes,
        });

    let message: string | null = null;
    if (decision.alert === "down") {
      message = target.label + " is DOWN. " + (decision.state.detail || "") + "\n\nFix: " + target.fix;
    } else if (decision.alert === "up") {
      message = target.label + " is back UP.";
    }

    // The state is stored, with the alert text when Telegram is set up, before any alert is
    // awaited. A heartbeat that landed while this check ran has newer state, so this target is
    // left alone until the next run, and a text that was resent and accepted is removed from it.
    const stored = message !== null ? (telegramReady(env) ? message : undefined) : pending;
    const decided = withPending(decision.state, stored);
    if (needsWrite(prev, decided, now)) {
      if (await newerBeatLanded(env, target, prev)) {
        if (prev.pendingAlert !== undefined && pending === undefined) {
          await clearPending(env, target.id, prev.pendingAlert);
        }
        continue;
      }
      await writeState(env, target.id, decided);
    }

    if (decision.change) changes.push(decision.change);

    if (message !== null) {
      const outcome = await alert(env, message);
      if (outcome !== "failed" && stored === message) await clearPending(env, target.id, message);
    }
  }

  return changes;
}

function withPending(state: TargetState, pending: string | undefined): TargetState {
  if (pending === undefined) return state;
  return { ...state, pendingAlert: pending };
}

// Removes a stored alert text once Telegram has accepted it, and only that text.
async function clearPending(env: Env, id: string, text: string): Promise<void> {
  const state = await readState(env, id);
  if (state.pendingAlert !== text) return;
  const next: TargetState = { ...state };
  delete next.pendingAlert;
  await writeState(env, id, next);
}

function telegramReady(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(env.TELEGRAM_CHAT_ID);
}

function needsWrite(prev: TargetState, next: TargetState, now: number): boolean {
  return (
    next.status !== prev.status ||
    next.consecutiveFailures !== prev.consecutiveFailures ||
    next.lastBeat !== prev.lastBeat ||
    next.detail !== prev.detail ||
    next.pendingAlert !== prev.pendingAlert ||
    now - prev.lastCheck >= HOUR
  );
}

async function newerBeatLanded(env: Env, target: Target, basis: TargetState): Promise<boolean> {
  if (target.kind !== "beat") return false;
  const fresh = await readState(env, target.id);
  if (fresh.lastBeat === undefined) return false;
  return basis.lastBeat === undefined || fresh.lastBeat > basis.lastBeat;
}

async function checkHttp(target: Extract<Target, { kind: "http" }>): Promise<CheckResult> {
  try {
    const res = await fetch(target.url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "fleet-canary (Cloudflare Worker)" },
      signal: AbortSignal.timeout(12000),
    });
    return interpretHttp(res.status, target.expect);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return interpretHttpError(message);
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null;
}

function isTargetState(raw: unknown): raw is TargetState {
  if (!isRecord(raw)) return false;
  const status = raw.status;
  if (status !== "up" && status !== "down" && status !== "unknown") return false;
  if (typeof raw.consecutiveFailures !== "number") return false;
  if (typeof raw.lastCheck !== "number") return false;
  if (raw.lastBeat !== undefined && typeof raw.lastBeat !== "number") return false;
  if (raw.detail !== undefined && typeof raw.detail !== "string") return false;
  if (raw.pendingAlert !== undefined && typeof raw.pendingAlert !== "string") return false;
  return true;
}

async function readState(env: Env, id: string): Promise<TargetState> {
  const raw = await env.CANARY.get<unknown>(STATE_PREFIX + id, "json");
  if (isTargetState(raw)) return raw;
  return emptyState();
}

async function writeState(env: Env, id: string, state: TargetState): Promise<void> {
  await env.CANARY.put(STATE_PREFIX + id, JSON.stringify(state));
}

async function readAll(env: Env): Promise<Record<string, TargetState & { label: string }>> {
  const out: Record<string, TargetState & { label: string }> = {};
  for (const t of TARGETS) {
    out[t.id] = { ...(await readState(env, t.id)), label: t.label };
  }
  return out;
}

async function alert(env: Env, message: string): Promise<AlertOutcome> {
  if (!telegramReady(env)) return "skipped";
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    // Alerting must never take the check loop down with it.
    return "failed";
  }
}

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Fleet Canary</title>
<style>
body{margin:0;padding:1.5rem;background:#0f1020;color:#e8e6f5;font:14px/1.6 ui-monospace,Menlo,monospace}
h1{font-size:1rem;color:#f6c453;letter-spacing:.06em;margin:0 0 .2rem}
.sub{color:#9a97b8;font-size:.8rem;margin-bottom:1.2rem}
.row{display:flex;justify-content:space-between;gap:1rem;background:#191a2e;border:1px solid #2c2e4a;border-radius:6px;padding:.7rem .9rem;margin-bottom:.5rem}
.up{color:#5ee0a0}.down{color:#ff6b6b}.unknown{color:#9a97b8}
.det{color:#9a97b8;font-size:.78rem}
</style></head><body>
<h1>FLEET CANARY</h1>
<div class="sub">Runs on Cloudflare's edge, so it keeps watching when the machines are off.</div>
<div id="list">loading...</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
fetch('/status').then(function(r){return r.json()}).then(function(d){
  var h='';
  Object.keys(d).forEach(function(k){
    var t=d[k];
    var age=t.lastBeat?Math.floor((Date.now()-t.lastBeat)/60000)+'m ago':'';
    var st=t.status==='up'||t.status==='down'?t.status:'unknown';
    h+='<div class="row"><span>'+esc(t.label)+'<div class="det">'+esc(t.detail||'')+' '+esc(age)+'</div></span>'+
       '<span class="'+st+'">'+st.toUpperCase()+'</span></div>';
  });
  document.getElementById('list').innerHTML=h||'no targets';
});
</script></body></html>`;
}
