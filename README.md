# CallHippo agent monitor

Posts to Slack when **no CallHippo agent is available to take calls**, and again when someone comes back.

Every 5 minutes a GitHub Actions job reads the same data the **Dashboard → Monitor Users** tab shows, and counts the agents in the `WATCH_EMAILS` secret who are *On Call* or *Idle*.

| Situation | Slack message |
|---|---|
| Available agents drop to 0 (confirmed by a re-check 45 s later) | :rotating_light: No CallHippo agents are available… |
| Still 0 after 60 min | Reminder with how long it's been |
| First agent comes back | :white_check_mark: back online after N min, with names |
| Saved CallHippo session expires | :warning: monitor is signed out (refresh the cookie) |
| Monitor fails 3 runs in a row (CallHippo down, page changed) | :warning: monitor can't read agent status |

> This uses CallHippo's internal dashboard endpoint (`/liveCall/<userId>`), not a documented API. If CallHippo changes their dashboard it may stop working — you'll get the :warning: message when that happens. Switch to the official API once CallHippo adds availability to `GET /v1/user/list`.

## Setup

### 1. A signed-in CallHippo session (Google sign-in)
CallHippo only allows Google sign-in for this org, which a script can't do. Instead the script reuses the login cookie from a browser session that's already signed in.

1. Use a **dedicated account** if you can (e.g. a monitor@ Google account added to CallHippo with access to Dashboard → Monitor Users). Anyone holding this cookie can act as that user, so avoid using an admin's personal session.
2. In Chrome, open a **new profile or Incognito window**, go to `web.callhippo.com` and sign in with Google.
3. Open **Dashboard → Monitor Users**, then DevTools (`Cmd+Option+I`) → **Network** tab → reload the page.
4. Click the request named **`liveCall/…`**:
   - The part after `liveCall/` in its URL is your **user ID** → secret `CALLHIPPO_USER_ID`.
   - Under **Request Headers**, copy the whole value of **`cookie`** → secret `CALLHIPPO_COOKIE`.
5. **Close the window without clicking Logout** — logging out kills the session the script is using.

**When the session expires** the script posts *":warning: CallHippo monitor is signed out"* to Slack once. Repeat steps 2–5 and update `CALLHIPPO_COOKIE` (the user ID stays the same). Note how long the first session lasts so you know how often to expect this.

*(If CallHippo ever allows password login for a user, set `CALLHIPPO_EMAIL` + `CALLHIPPO_PASSWORD` instead and remove `CALLHIPPO_COOKIE`; the script will log in with headless Chrome.)*

### 2. A Slack incoming webhook
Slack → *Apps* → **Incoming Webhooks** (or create an app at api.slack.com/apps → Incoming Webhooks) → choose the alert channel → copy the `https://hooks.slack.com/services/...` URL.

### 3. Repository secrets and variables
Repo → *Settings → Secrets and variables → Actions*

**Secrets**
| Name | Value |
|---|---|
| `CALLHIPPO_COOKIE` | the copied `cookie` header (step 1) |
| `CALLHIPPO_USER_ID` | the ID from the `liveCall/…` URL (step 1) |
| `SLACK_WEBHOOK_URL` | the Slack webhook / Workflow Builder trigger URL |
| `WATCH_EMAILS` | comma-separated CallHippo emails of the agents to watch (e.g. the L1 team) |

**Variables** (all optional)
| Name | Default | Meaning |
|---|---|---|
| `ALERT_MODE` | `alert` | `log` = don't post to Slack, only record results in the run summary (use for the first week) |
| `BREAK_COUNTS_AS_ONLINE` | `false` | treat Break/Lunch/Meeting as available |
| `REMINDER_MINUTES` | `60` | repeat the alert every N minutes while still down (`0` = never) |

### 4. Turn it on
Push the repo, then *Actions → CallHippo agent monitor → Run workflow* once to test. After that it runs on the schedule.

## Things to know
- **Timing:** GitHub's minimum schedule is 5 minutes and runs can start a few minutes late, so expect alerts within ~5–10 min.
- **Public repo, no personal data:** this repo is meant to be public (Actions minutes are free for public repos). Everything identifying lives in secrets, which GitHub never shows. Run logs are public, so the script only logs counts — never names, emails, Slack text or screenshots — and redacts any secret that might appear in an error.
- **To change who is watched,** edit the `WATCH_EMAILS` secret (Settings → Secrets → Actions). Never commit emails to the repo.
- **Schedule keep-alive:** GitHub pauses schedules in public repos after 60 days without commits; the workflow re-enables itself every run to prevent that.
- **Debugging:** each run's summary shows the counts it read. For a page screenshot, run locally with `SAVE_SCREENSHOT=true`.

## Local run
```bash
npm install
CALLHIPPO_COOKIE='...' CALLHIPPO_USER_ID=... WATCH_EMAILS=a@x.com,b@x.com ALERT_MODE=log node monitor.mjs
npm test
```
