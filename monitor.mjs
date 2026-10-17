// CallHippo "no agents available" monitor.
// Logs into the CallHippo web dashboard with a dedicated password-based user, reads the same
// data the Monitor Users tab uses, and posts to Slack when nobody is available to take calls.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { summarize, decide, minutesBetween } from './lib.mjs';

const env = (k, d) => (process.env[k] ?? '').trim() || d;

// WATCH_EMAILS (comma-separated, from a GitHub secret) wins; otherwise a local agent list file
// (git-ignored, for local runs); otherwise watch everyone.
function loadWatchList(fromEnv, file) {
  if (fromEnv) return fromEnv.split(',').map((e) => e.trim()).filter(Boolean);
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  } catch { return []; }
}
const cfg = {
  // Session mode (for Google sign-in orgs): reuse a signed-in browser session; no login, no Chrome.
  sessionCookie: env('CALLHIPPO_COOKIE'),
  userId: env('CALLHIPPO_USER_ID', '').replace(/"/g, ''),
  email: env('CALLHIPPO_EMAIL'),
  password: env('CALLHIPPO_PASSWORD'),
  slackWebhook: env('SLACK_WEBHOOK_URL'),
  baseUrl: env('CALLHIPPO_BASE_URL', 'https://web.callhippo.com'),
  mode: env('ALERT_MODE', 'alert'), // 'alert' posts to Slack, 'log' only writes the run summary
  watchEmails: loadWatchList(env('WATCH_EMAILS', ''), env('WATCH_FILE', 'l1-agents.txt')),
  breakCountsAsOnline: env('BREAK_COUNTS_AS_ONLINE', 'false') === 'true',
  confirmDelaySec: Number(env('CONFIRM_DELAY_SEC', '45')),
  reminderMinutes: Number(env('REMINDER_MINUTES', '60')),
  failureAlertAfter: Number(env('FAILURE_ALERT_AFTER', '3')),
  stateFile: env('STATE_FILE', '.state/state.json'),
  chromeChannel: env('CHROME_CHANNEL', 'chrome'), // GitHub's ubuntu runners ship Google Chrome
  emailSelector: env('EMAIL_SELECTOR', 'input[type="email"], input[name="email"], input[name="username"]'),
  passwordSelector: env('PASSWORD_SELECTOR', 'input[type="password"]'),
  submitSelector: env('SUBMIT_SELECTOR', 'button[type="submit"]:visible, button:visible:has-text("Login"), button:visible:has-text("Log in"), button:visible:has-text("Sign in"), button:visible:has-text("Continue"), button:visible:has-text("Next")'),
};

// The repo is public, so its run logs are too: never print names, emails or secrets.
const secretsToHide = () => [cfg.email, cfg.password, cfg.slackWebhook, cfg.sessionCookie, cfg.userId, ...cfg.watchEmails].filter((v) => v && v.length > 3);
const redact = (t) => secretsToHide().reduce((acc, v) => acc.split(v).join('***'), String(t))
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
const log = (...a) => console.log(new Date().toISOString(), ...a.map(redact));
const summaryLines = [];
const summary = (line) => { summaryLines.push(line); log(line); };

function readState() {
  try { return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(cfg.stateFile.replace(/\/[^/]*$/, '') || '.', { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify(s, null, 2));
}

async function postSlack(text) {
  if (cfg.mode !== 'alert') { summary('[log mode] would post this message to Slack (text hidden in public logs)'); return; }
  if (!cfg.slackWebhook) throw new Error('SLACK_WEBHOOK_URL is not set');
  const r = await fetch(cfg.slackWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Slack webhook returned ${r.status}: ${await r.text()}`);
}

async function login(page) {
  await page.goto(`${cfg.baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator(cfg.emailSelector).first().fill(cfg.email, { timeout: 30_000 });
  const pwd = page.locator(cfg.passwordSelector).first();
  if (!(await pwd.isVisible().catch(() => false))) {
    // Two-step login: submit the email first, then the password field appears.
    await page.locator(cfg.submitSelector).first().click();
    await pwd.waitFor({ state: 'visible', timeout: 30_000 });
  }
  await pwd.fill(cfg.password);
  await page.locator(cfg.submitSelector).first().click();
  await page.waitForURL((u) => !/\/login/i.test(u.pathname), { timeout: 60_000, waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');
}

class SessionExpired extends Error {}

// Session mode: call the dashboard endpoint directly with the saved cookie.
async function readAgentsWithCookie() {
  const r = await fetch(`${cfg.baseUrl}/liveCall/${cfg.userId}`, {
    headers: { cookie: cfg.sessionCookie, accept: 'application/json' },
    redirect: 'manual',
  });
  const body = await r.text();
  let j;
  try { j = JSON.parse(body); } catch { /* HTML login page = not signed in */ }
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400) || (!j && r.ok)) {
    throw new SessionExpired(`CallHippo session is no longer valid (HTTP ${r.status})`);
  }
  if (!r.ok) throw new Error(`/liveCall returned HTTP ${r.status}`);
  if (!j?.data?.agents) {
    if (j && j.success === false) throw new SessionExpired('CallHippo rejected the saved session');
    throw new Error('/liveCall response has no data.agents');
  }
  return j.data.agents;
}

async function readAgents(page) {
  // Same request the Monitor Users tab makes; the browser session supplies auth.
  return page.evaluate(async () => {
    const raw = localStorage.getItem('user_id') || '';
    const userId = raw.replace(/"/g, '');
    if (!userId) throw new Error('Logged in, but user_id not found in localStorage');
    const r = await fetch(`/liveCall/${userId}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`/liveCall returned HTTP ${r.status}`);
    const j = await r.json();
    if (!j || !j.data || !j.data.agents) throw new Error('/liveCall response has no data.agents');
    return j.data.agents;
  });
}

function firstLine(err) {
  return redact(String(err?.message || err).split('\n')[0]).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300);
}

function describe(s) {
  return `available ${s.online} (on call ${s.onCall}, idle ${s.idle}), break ${s.onBreak}, offline ${s.offline}`;
}

async function main() {
  const sessionMode = Boolean(cfg.sessionCookie);
  if (sessionMode && !cfg.userId) throw new Error('CALLHIPPO_USER_ID must be set with CALLHIPPO_COOKIE');
  if (!sessionMode && (!cfg.email || !cfg.password)) {
    throw new Error('Set CALLHIPPO_COOKIE + CALLHIPPO_USER_ID (Google sign-in) or CALLHIPPO_EMAIL + CALLHIPPO_PASSWORD');
  }
  const state = readState();
  const opts = { watchEmails: cfg.watchEmails, breakCountsAsOnline: cfg.breakCountsAsOnline };
  if (sessionMode) return check(state, opts, null, null, readAgentsWithCookie);

  const executablePath = env('CHROME_PATH');
  const browser = await chromium.launch(
    executablePath ? { executablePath, headless: true } : { channel: cfg.chromeChannel || undefined, headless: true },
  );
  const page = await browser.newPage();
  return check(state, opts, browser, page, async () => readAgents(page), () => login(page));
}

async function check(state, opts, browser, page, read, login = async () => {}) {
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  let s;
  try {
    await login();
    s = summarize(await read(), opts);
    summary(`Watching ${cfg.watchEmails.length || 'all'} agents. Check 1: ${describe(s)}`);
    if (s.unknownEmails.length) {
      summary(`WARNING: ${s.unknownEmails.length} email(s) in WATCH_EMAILS not found in CallHippo — check the secret for typos or removed users`);
    }

    // Confirm a zero reading before alerting, to skip brief reconnects.
    if (s.online === 0 && !state.down && cfg.confirmDelaySec > 0) {
      await wait(cfg.confirmDelaySec * 1000);
      s = summarize(await read(), opts);
      summary(`Check 2 (after ${cfg.confirmDelaySec}s): ${describe(s)}`);
    }
  } catch (err) {
    if (page && env('SAVE_SCREENSHOT') === 'true') { // local debugging only; never in public CI
      fs.mkdirSync('debug', { recursive: true });
      await page.screenshot({ path: 'debug/failure.png', fullPage: true }).catch(() => {});
    }
    await browser?.close();
    state.failures = (state.failures || 0) + 1;
    summary(`Check failed (${state.failures} in a row): ${firstLine(err)}`);
    if (err instanceof SessionExpired && !state.sessionAlerted) {
      // No point waiting for 3 failures: an expired session won't fix itself.
      state.sessionAlerted = true;
      state.failures = Math.max(state.failures, cfg.failureAlertAfter);
      await postSlack(
        ':warning: *CallHippo monitor is signed out* — L1 availability alerts are paused. ' +
        'Sign in to CallHippo as the monitor user and update the `CALLHIPPO_COOKIE` GitHub secret (steps in the repo README).',
      ).catch((e) => summary(`Slack post failed: ${e.message}`));
    } else if (state.failures === cfg.failureAlertAfter) {
      await postSlack(
        `:warning: *CallHippo monitor can't read agent status* (${state.failures} failed checks in a row). ` +
        `Alerts are paused until it recovers. Error: ${firstLine(err)}`,
      ).catch((e) => summary(`Slack post failed: ${e.message}`));
    }
    writeState(state);
    throw err;
  }
  await browser?.close();
  state.sessionAlerted = false;

  const recovered = (state.failures || 0) >= cfg.failureAlertAfter;
  state.failures = 0;
  if (recovered) await postSlack(':white_check_mark: CallHippo monitor is reading agent status again.');

  const now = Date.now();
  const { post, state: next } = decide(state, s.online === 0, now, cfg.reminderMinutes);
  const breakNote = s.onBreak ? ` ${s.onBreak} on break: ${s.breakNames.join(', ')}.` : '';
  if (post === 'down') {
    await postSlack(`:rotating_light: *No L1 agents are available to take calls in CallHippo.* ${describe(s)}.${breakNote}`);
  } else if (post === 'reminder') {
    await postSlack(`:rotating_light: Still no L1 agents available — ${minutesBetween(next.downSince, now)} min so far. ${describe(s)}.${breakNote}`);
  } else if (post === 'up') {
    await postSlack(`:white_check_mark: L1 agents are back online after ${minutesBetween(next.downSince, now)} min: ${s.onlineNames.join(', ')}.`);
  }
  summary(`Result: ${s.online === 0 ? 'NO AGENTS AVAILABLE' : 'ok'}${post ? ` → posted "${post}"` : ''}`);
  writeState(next);
}

main()
  .catch((err) => { console.error(redact(firstLine(err))); process.exitCode = 1; })
  .finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.map((l) => `- ${redact(l)}`).join('\n') + '\n');
    }
  });
