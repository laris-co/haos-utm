#!/usr/bin/env bun
/**
 * Complete HAOS onboarding over the REST API — no browser, no clicking.
 *
 * WHY THIS EXISTS
 * Onboarding was assumed to be UI-only for most of 2026-08-24, which made it a
 * hard blocker on every provisioning run: a human had to open a browser and
 * type a password before add-ons could be installed. It is not UI-only. The
 * frontend just calls a REST API, and the first call needs NO AUTHENTICATION —
 * it cannot, because no user exists yet to authenticate as.
 *
 * Verified against homeassistant/components/onboarding/views.py (core dev) and
 * run end-to-end against a real guest (a live HAOS guest, 2026-08-24).
 *
 * THE FLOW
 *   1. POST /api/onboarding/users        no auth  -> { auth_code }
 *   2. POST /auth/token                  grant_type=authorization_code
 *                                        -> { access_token }
 *   3. POST /api/onboarding/core_config  bearer   -> {}
 *   4. POST /api/onboarding/analytics    bearer   -> {}
 *   5. POST /api/onboarding/integration  bearer   -> { auth_code }
 *
 * SECURITY NOTE
 * `--pass` puts the password in shell history and in the process list while it
 * runs. That is acceptable for a throwaway lab guest on a trusted LAN and NOT
 * acceptable for anything reachable from outside it.
 *
 * `--pass-file` is the way out and should be preferred everywhere: the secret
 * is read from a file this process opens, so it appears in no argv, no `ps`,
 * and no history. Generate it the same way `just arra-rotate` does — never by
 * echoing it into view:
 *
 *   umask 077 && openssl rand -base64 24 | tr -d '\n' > /tmp/haos-pass.txt
 *   bun scripts/onboard.ts --ip <IP> --user admin --pass-file /tmp/haos-pass.txt
 *
 * A trailing newline is stripped, because every ordinary way of writing such a
 * file adds one and a password that differs by an invisible byte fails in a way
 * that reads as "wrong password".
 *
 * usage:
 *   bun scripts/onboard.ts --ip <GUEST_IP> --user admin \
 *                          (--pass 'secret' | --pass-file PATH) \
 *                          [--name homeassistant] [--port 80]
 */

import { $ } from "bun";
import { readFileSync } from "node:fs";

$.throws(false);

const grn = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const ok = (s: string) => console.log(`${grn("✓")} ${s}`);
const info = (s: string) => console.log(`  ${s}`);
const die = (s: string): never => {
  console.error(red(`✗ ${s}`));
  process.exit(1);
};

/** One entry of GET /api/onboarding. */
interface OnboardingStep {
  step: string;
  done: boolean;
}

const isStepArray = (v: unknown): v is OnboardingStep[] =>
  Array.isArray(v) &&
  v.every((x) => typeof x === "object" && x !== null &&
    "step" in x && "done" in x);

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const need = (n: string) => flag(n) ?? die(`--${n} is required`);

const ip = need("ip");
const user = need("user");

/**
 * The password, preferring the file so it never reaches argv.
 *
 * Exactly one of the two must be given: silently letting `--pass` win over a
 * `--pass-file` that was misspelled or unreadable would onboard with the wrong
 * secret and look like success.
 */
const pass = ((): string => {
  const file = flag("pass-file");
  const inline = flag("pass");
  if (file && inline) die("give --pass-file or --pass, not both");
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      return die(`--pass-file ${file} unreadable: ${(e as Error).message}`);
    }
    // Trailing newline only — a password may legitimately start or end with a
    // space, and trimming both ends would silently change it.
    const value = raw.replace(/\r?\n$/, "");
    return value || die(`--pass-file ${file} is empty`);
  }
  return inline ?? die("--pass-file (preferred) or --pass is required");
})();

const name = flag("name") ?? user;
const port = flag("port") ?? "80";

/**
 * Which port actually serves the API?
 *
 * Do not assume. A fresh HAOS serves onboarding on :8123 and 302-redirects :80
 * there; an onboarded one with server_port:80 serves :80 directly. Guessing
 * wrong yields an HTML redirect page where JSON was expected. If --port is
 * given explicitly, trust the operator and skip the probe.
 */
async function resolveBase(): Promise<string> {
  if (flag("port")) return `http://${ip}${port === "80" ? "" : `:${port}`}`;
  for (const p of ["8123", "80"]) {
    const u = `http://${ip}${p === "80" ? "" : `:${p}`}`;
    const r = await fetch(`${u}/api/onboarding`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    // a redirect means "the real one is elsewhere"; anything else means this is it
    if (r && r.status !== 301 && r.status !== 302 && r.status !== 307) {
      info(`API port: ${p}`);
      return u;
    }
  }
  return `http://${ip}:8123`; // fresh-guest default
}

const base = await resolveBase();

/**
 * Where the API actually LANDED, once we know.
 *
 * resolveBase() runs BEFORE the guest answers, so on a cold provision both its
 * probes fail and it returns the :8123 default. A settled guest then 307s
 * :8123 -> :80, and HTTP clients DROP the Authorization header across that
 * redirect because the origin changed — a valid bearer token yields 401 on the
 * first authenticated call. Found 2026-08-24 with a Swift port of this script;
 * this file had the identical bug and had simply never been unlucky enough to
 * resolve before the guest was up.
 */
let effectiveBase: string | undefined;
const activeBase = () => effectiveBase ?? base;
const clientId = () => `${activeBase()}/`;
const originOf = (u: string) => new URL(u).origin;

async function jsonPost(path: string, body: unknown, token?: string) {
  const res = await fetch(`${activeBase()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) die(`${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Wait until the onboarding API is genuinely ready.
 *
 * The HTTP status here tracks BOOT PROGRESS, not onboarding state — documented
 * independently (2026-08-18) and hit again on a fresh build: a fresh
 * guest returns 401 on this endpoint while core is still starting, and :80
 * 302-redirects to :8123 until the port is settled. The frontend answering 200
 * does NOT mean the API is up. Parsing the body blindly gets you a JSON error
 * on an HTML redirect page.
 *
 * So: follow redirects, accept only a JSON array, and treat everything else as
 * "still booting" until the deadline.
 */
async function waitForOnboardingApi(
  timeoutMs = 180_000,
): Promise<OnboardingStep[] | "complete"> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "";
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/onboarding`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (res?.status === 404) {
      if (res.url) effectiveBase = originOf(res.url);
      return "complete" as const;
    }

    if (res?.ok) {
      const text = await res.text();
      try {
        const parsed: unknown = JSON.parse(text);
        if (isStepArray(parsed)) {
          if (res.url) effectiveBase = originOf(res.url);
          return parsed;
        }
      } catch { /* HTML redirect page or partial boot output */ }
      lastSeen = `200 but not JSON: ${text.slice(0, 60)}`;
    } else {
      // 401 = core still starting. 302 = port not settled. Both are "wait".
      lastSeen = `HTTP ${res?.status ?? "no response"}`;
    }
    info(`waiting for onboarding API… (${lastSeen})`);
    await Bun.sleep(10_000);
  }
  return die(`onboarding API never became ready — last: ${lastSeen}`);
}

const steps = await waitForOnboardingApi();
if (steps === "complete") {
  ok("onboarding already complete (views deregistered) — nothing to do");
  process.exit(0);
}
if (steps.every((s) => s.done)) {
  ok("onboarding already complete (all steps done) — nothing to do");
  process.exit(0);
}
info(`pending: ${steps.filter((s) => !s.done).map((s) => s.step).join(", ")}`);
info(`API base: ${activeBase()}`);

/**
 * Log in as an EXISTING user to obtain an auth_code.
 *
 * Needed because onboarding is not atomic. If a run creates the user and then
 * dies (observed live — token fine, next call 401), the `user` step
 * is permanently done and POST /api/onboarding/users can never succeed again.
 * Without this path the only recovery is destroying the guest and rebuilding.
 */
async function authCodeByLogin(): Promise<string> {
  const start = await jsonPost("/auth/login_flow", {
    client_id: clientId(),
    handler: ["homeassistant", null],
    redirect_uri: clientId(),
  });
  if (!start.flow_id) die("could not start a login flow — is the password correct?");
  const done = await jsonPost(`/auth/login_flow/${start.flow_id}`, {
    client_id: clientId(),
    username: user,
    password: pass,
  });
  if (done.type !== "create_entry" || !done.result) {
    die(`login rejected for ${user} — wrong password, or the user step was done with other credentials`);
  }
  return done.result as string;
}

// ── 1. obtain an auth_code — create the owner, or log in as one that exists ──
let auth_code: string;
if (steps.some((s) => s.step === "user" && s.done)) {
  info("user step already done — logging in instead of creating");
  auth_code = await authCodeByLogin();
  ok(`authenticated as existing user "${user}"`);
} else {
  // NO AUTH here — no user exists yet to authenticate as.
  const created = await jsonPost("/api/onboarding/users", {
    name,
    username: user,
    password: pass,
    client_id: clientId(),
    language: "en",
  });
  if (!created.auth_code) die("no auth_code returned from /api/onboarding/users");
  auth_code = created.auth_code;
  ok(`owner "${user}" created`);
}

// ── 2. exchange the code for a bearer token ─────────────────────────────────
const form = new URLSearchParams({
  grant_type: "authorization_code",
  code: auth_code,
  client_id: clientId(),
});
const tokRes = await fetch(`${activeBase()}/auth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: form,
  signal: AbortSignal.timeout(20_000),
});
if (!tokRes.ok) die(`/auth/token -> HTTP ${tokRes.status}`);
const { access_token } = await tokRes.json();
if (!access_token) die("no access_token returned");
ok("exchanged auth_code for access token");

// ── 3-5. the authenticated steps ────────────────────────────────────────────
/**
 * Skip steps the guest has already completed.
 *
 * The `user` step was already guarded this way; the other three were not, so a
 * run that failed partway could never be finished — the retry died on
 * `core_config -> HTTP 403: Core config step already done` before reaching the
 * step that was actually pending. Observed on a live guest, 2026-08-28.
 *
 * The pending list is read from the guest, so this stays correct whether the
 * earlier partial run was ours or someone else's.
 */
const needs = (step: string) => steps.some((s) => s.step === step && !s.done);
const skip = (step: string) => ok(`${step} already done — skipped`);

if (needs("core_config")) {
  await jsonPost("/api/onboarding/core_config", {}, access_token);
  ok("core_config done");
} else skip("core_config");

if (needs("analytics")) {
  await jsonPost("/api/onboarding/analytics", {}, access_token);
  ok("analytics done");
} else skip("analytics");
// Both values must be CALLED. Passing the bare `clientId` function made
// JSON.stringify drop the key entirely — a silently absent field, not a wrong
// one — and HA answered `required key not provided @ data['redirect_uri']`.
// Observed on a live guest, 2026-08-28: the first four steps succeeded and onboarding
// was left permanently at integration:false.
if (needs("integration")) {
  await jsonPost("/api/onboarding/integration",
    { client_id: clientId(), redirect_uri: clientId() }, access_token);
  ok("integration done");
} else skip("integration");

// ── verify from the outside, do not trust the responses ─────────────────────
const after = await fetch(`${activeBase()}/api/onboarding`, {
  signal: AbortSignal.timeout(15_000),
});
if (after.status === 404) {
  ok("verified: onboarding views deregistered");
} else {
  const s: unknown = await after.json();
  const pending = isStepArray(s)
    ? s.filter((x) => !x.done).map((x) => x.step)
    : ["<unparseable onboarding status>"];
  if (pending.length) die(`still pending after run: ${pending.join(", ")}`);
  ok("verified: all steps report done");
}

info(`log in at ${activeBase()}/ as ${user}`);
