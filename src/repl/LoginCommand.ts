// `/login` slash-command handler — Plan 8 Phase A (manual key) + Phase B
// (browser device-flow).
//
// Two invocation shapes:
//   1. `/login` (no args)         → Phase B device-flow: opens the browser
//                                    to `bvrai.ca/cli-auth?code=XXXX-XXXX`,
//                                    polls `/v1/auth/device/poll` until the
//                                    user approves on the website, saves
//                                    the minted `sk_amx_…` key, shows the
//                                    balance. This is the default UX.
//   2. `/login sk_amx_…` (with arg) → Phase A manual flow: validates the
//                                    pasted key against `/v1/usage/me` and
//                                    saves it. Kept as a fallback for the
//                                    occasional case where device-flow
//                                    isn't viable (headless SSH, browser
//                                    won't open, etc.).
//
// Inside V6 (`AUTOMAX_PROXY_TOKEN` set), `/login` short-circuits to a
// helpful no-op message — `printAlreadyAuthenticatedNotice` — per Plan 8
// Open Decision #4 (a). V6's own session owns the auth.
//
// Device-flow contract is IETF RFC 8628 with Conduit's parameters:
//   - `device_code` (32-char base62), `user_code` (XXXX-XXXX from Crockford
//     alphabet), `verification_uri_complete` (full URL with code prefilled).
//   - `expires_in: 600` (10 min total budget).
//   - `interval: 5` (5s initial poll cadence).
//   - On `slow_down` response: add 5s to interval, hard cap 15s.
//   - Terminal statuses: `ok` (with `access_token`) / `expired` / `denied`.

import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { proxyRootUrl } from '../auth/AuthResolver.js';
import { BVRAI_API_KEYS_URL } from '../auth/firstRun.js';
import { setSecret } from '../auth/SecretStore.js';
import { osOpenCommand } from '../util/host.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';

const AMX_KEY_PREFIX = 'sk_amx_';
// `sk_amx_` (7) + 32-char body per Conduit's contract = 39 total. Allow a
// little slack on the lower bound (Conduit is the source of truth), just
// catch obviously-malformed pastes here so we don't waste a round-trip.
const MIN_KEY_LENGTH = AMX_KEY_PREFIX.length + 8;
const VALIDATE_TIMEOUT_MS = 10_000;

// Shape of `GET /v1/usage/me` response — Plan 6 + Plan 8 shared facts.
// All fields optional in our parse because we treat the response defensively;
// Conduit's contract guarantees them but we never want a missing field to
// derail the login success path.
interface UsageMe {
  tier?: string;
  subscriptionCreditCents?: number;
  topUpCreditCents?: number;
  totalCreditCents?: number;
  currentPeriodEnd?: string;
}

type ValidationOutcome =
  | { kind: 'ok'; usage: UsageMe }
  | { kind: 'invalid' }       // 401/403 — key rejected
  | { kind: 'transient' };    // 5xx / network / timeout — persist with warning

// Device-flow response shapes from Conduit's contract (Plan 8 Round 1).
interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;  // seconds
  interval: number;    // seconds
}

type DevicePollResponse =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'ok'; access_token: string };

export interface DeviceFlowOptions {
  // Test-only override to bypass real polling sleeps. Production code
  // always uses the interval Conduit returned in /v1/auth/device/start.
  pollIntervalOverrideMs?: number;
}

// Prints a hint after wizard-driven signup that tells the user how to
// chain into login. The actual device-flow runs in-Bridge once the user
// types /login at the prompt; we don't try to run it from cli.ts before
// Bridge mounts because the user_code would scroll past Bridge's
// alt-screen takeover.
export function printLoginInstructions(renderer: ConsoleRenderer): void {
  renderer.info('');
  renderer.info(`Once you've signed up, type ${pc.cyan('/login')} below to log in via your browser.`);
  renderer.dim('(AutoCode will show a one-time code and open the approval page automatically.)');
}

export async function runLogin(
  renderer: ConsoleRenderer,
  keyArg: string | undefined,
  options: DeviceFlowOptions = {},
): Promise<void> {
  // No-arg invocation → device flow (Plan 8 Phase B).
  if (keyArg === undefined || keyArg.length === 0) {
    await runDeviceFlow(renderer, options);
    return;
  }

  const pasted = keyArg.trim();

  if (!pasted.startsWith(AMX_KEY_PREFIX)) {
    renderer.error(
      `Key must start with "${AMX_KEY_PREFIX}". Got "${truncate(pasted, 20)}" — try again with the full sk_amx_ key as the argument.`,
    );
    return;
  }
  if (pasted.length < MIN_KEY_LENGTH) {
    renderer.error('Key seems too short — copy the full sk_amx_ value and try again.');
    return;
  }

  const proxyBase = proxyRootUrl();
  renderer.dim(`Validating against ${proxyBase}…`);
  const outcome = await validateKey(pasted, proxyBase);

  if (outcome.kind === 'invalid') {
    renderer.error(
      'The proxy rejected the key (invalid or revoked). Not saved. Generate a fresh key at ' +
        BVRAI_API_KEYS_URL +
        ' and try again.',
    );
    return;
  }

  // Persist on both ok and transient (the key is presumably good in the
  // transient case; user can revoke + re-login if it turns out broken).
  // Goes through SecretStore → OS keyring on capable systems, plaintext
  // config fallback otherwise.
  await setSecret('amx', pasted);

  if (outcome.kind === 'transient') {
    renderer.warn(
      `Couldn't reach ${proxyBase} to validate — saved the key anyway. ` +
        'If your next prompt fails, run /login again with a fresh key.',
    );
    return;
  }

  // Success path with balance display.
  renderer.info(`${pc.green('✓')} Logged in.`);
  const u = outcome.usage;
  const tier = u.tier ?? 'unknown';
  const sub = formatCents(u.subscriptionCreditCents ?? 0);
  const top = formatCents(u.topUpCreditCents ?? 0);
  const period = u.currentPeriodEnd ? formatPeriodEnd(u.currentPeriodEnd) : '(no period end)';
  renderer.info(`  Tier:                 ${tier}`);
  renderer.info(`  Subscription credits: ${sub}`);
  renderer.info(`  Top-up credits:       ${top}`);
  renderer.info(`  Period ends:          ${period}`);
  renderer.dim('Restart autocode (/exit then acv1) to use this account on the proxy.');
}

// Inside-V6 no-op for `/login` when V6 has already injected
// AUTOMAX_PROXY_TOKEN. Wording from Plan 8 Open Decision #4 — Forge's
// proposal, adopted verbatim by Smith Round 2. Email resolved by decoding
// the Firebase ID token's payload (well-formed JWT, `email` is a public
// claim); falls back to a generic line if the decode fails.
export function printAlreadyAuthenticatedNotice(renderer: ConsoleRenderer): void {
  const token = process.env.AUTOMAX_PROXY_TOKEN ?? '';
  const email = emailFromFirebaseJwt(token);
  if (email) {
    renderer.info(
      `You're already authenticated as ${email} via Automax. ` +
        'To use a different BVRAI account, exit and run `acv1` standalone.',
    );
  } else {
    renderer.info(
      "You're already authenticated via Automax. " +
        'To use a different BVRAI account, exit and run `acv1` standalone.',
    );
  }
}

// Phase B device-flow client (RFC 8628). Runs as a foreground polling loop;
// the user sees the user_code, approves in their browser, the loop sees
// `status: ok` and saves the minted key. Cancellable by aborting the
// process (Ctrl+C in standalone, or the Bridge's exit affordance).
//
// IO contract with Conduit (Plan 8 Round 1):
//   POST /v1/auth/device/start → { device_code, user_code,
//     verification_uri, verification_uri_complete, expires_in, interval }
//   POST /v1/auth/device/poll  → one of:
//     { status: "pending" }      — keep polling on current interval
//     { status: "slow_down" }    — add 5s to interval, cap at 15s
//     { status: "expired" }      — user took too long; abort
//     { status: "denied" }       — user clicked Deny; abort
//     { status: "ok", access_token } — approved; save the key
async function runDeviceFlow(
  renderer: ConsoleRenderer,
  options: DeviceFlowOptions,
): Promise<void> {
  const proxyBase = proxyRootUrl();

  // Step 1: request a device_code.
  let start: DeviceStartResponse;
  try {
    const res = await fetch(`${proxyBase}/v1/auth/device/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      renderer.error(
        `Couldn't start login (proxy returned ${res.status}). ` +
          `Try again, or fall back to /login sk_amx_… with a key from ${BVRAI_API_KEYS_URL}.`,
      );
      return;
    }
    start = (await res.json()) as DeviceStartResponse;
  } catch (e) {
    renderer.error(
      `Couldn't reach ${proxyBase} to start login: ${e instanceof Error ? e.message : String(e)}. ` +
        'Check your network and try again.',
    );
    return;
  }

  // Step 2: show the code prominently + open the browser.
  renderer.info('');
  renderer.info(`  ${pc.cyan('Code:')} ${pc.bold(start.user_code)}`);
  renderer.info(`  ${pc.dim('URL: ')} ${start.verification_uri_complete}`);
  renderer.info('');
  renderer.dim('Opening your browser…');
  openInDefaultBrowser(start.verification_uri_complete);
  renderer.dim('Waiting for you to approve in the browser (up to 10 minutes)…');

  // Step 3: poll until terminal status or expiry.
  let intervalMs = options.pollIntervalOverrideMs ?? start.interval * 1000;
  const HARD_CAP_MS = 15_000;
  const deadline = Date.now() + start.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll: DevicePollResponse;
    try {
      const res = await fetch(`${proxyBase}/v1/auth/device/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: start.device_code }),
      });
      if (!res.ok) {
        // Treat unexpected HTTP errors as transient; keep polling until
        // expires_in deadline. The contract says poll is always 200 in
        // the happy path with status in the body.
        continue;
      }
      poll = (await res.json()) as DevicePollResponse;
    } catch {
      // Network blip → keep polling.
      continue;
    }

    if (poll.status === 'pending') continue;
    if (poll.status === 'slow_down') {
      if (options.pollIntervalOverrideMs === undefined) {
        intervalMs = Math.min(intervalMs + 5_000, HARD_CAP_MS);
      }
      continue;
    }
    if (poll.status === 'denied') {
      renderer.error('Login was denied in the browser. Run /login again if you want to retry.');
      return;
    }
    if (poll.status === 'expired') {
      renderer.error('Login code expired before approval. Run /login to start over.');
      return;
    }
    if (poll.status === 'ok') {
      const key = poll.access_token;
      // Conduit just minted this key, so it's guaranteed valid — no extra
      // /v1/usage/me round-trip needed for validity. We still fetch
      // /usage/me for the balance display, but failure there doesn't
      // block the save.
      await setSecret('amx', key);

      renderer.info(`${pc.green('✓')} Approved + key saved.`);
      const usage = await fetchUsageQuiet(key, proxyBase);
      if (usage) {
        renderer.info(`  Tier:                 ${usage.tier ?? 'unknown'}`);
        renderer.info(`  Subscription credits: ${formatCents(usage.subscriptionCreditCents ?? 0)}`);
        renderer.info(`  Top-up credits:       ${formatCents(usage.topUpCreditCents ?? 0)}`);
        renderer.info(`  Period ends:          ${usage.currentPeriodEnd ? formatPeriodEnd(usage.currentPeriodEnd) : '(no period end)'}`);
      } else {
        renderer.dim('  (Balance unavailable right now — login itself succeeded.)');
      }
      renderer.dim('Restart autocode (/exit then acv1) to use this account on the proxy.');
      return;
    }
  }

  renderer.error('Login timed out (no approval within 10 minutes). Run /login to start over.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort balance fetch — used by the device-flow success path. Never
// throws; returns null on any error so we still show "key saved" on a
// transiently-flaky proxy.
async function fetchUsageQuiet(key: string, proxyBase: string): Promise<UsageMe | null> {
  try {
    const res = await fetch(`${proxyBase}/v1/usage/me`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageMe;
  } catch {
    return null;
  }
}

async function validateKey(key: string, proxyBase: string): Promise<ValidationOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${proxyBase}/v1/usage/me`, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { kind: 'invalid' };
    }
    if (!res.ok) {
      // 5xx / 429 / unexpected — treat as transient.
      return { kind: 'transient' };
    }
    const usage = (await res.json()) as UsageMe;
    return { kind: 'ok', usage };
  } catch {
    // Network error / timeout / parse error → transient.
    return { kind: 'transient' };
  } finally {
    clearTimeout(timer);
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatPeriodEnd(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// Decode a Firebase ID token (standard JWT) and return the `email` claim
// if present. JWT payload is base64url-encoded JSON; no signature
// verification — we trust the env var V6 just gave us. Returns null on any
// parse failure.
function emailFromFirebaseJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(decoded) as { email?: string };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

function openInDefaultBrowser(url: string): void {
  try {
    const { cmd, args } = osOpenCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* user can copy/paste the URL on screen */
  }
}
