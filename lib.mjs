// Pure logic: no network, no browser. Covered by test/lib.test.mjs.

/**
 * Turn the `data.agents` block of CallHippo's /liveCall/<userId> response into counts.
 *
 * Shape observed on the Monitor Users dashboard (Oct 2026):
 *   { onCallCount: [ids], idleCount: [ids], breakCount: [ids], logoutCount: [ids],
 *     finalArray: [{ _id, email, fullName, status, ... }] }
 *
 * "Available Agent" on the dashboard = on call + idle, so that is what counts as online.
 *
 * @param {object} agents       data.agents from the API
 * @param {object} opts
 * @param {string[]} [opts.watchEmails]  only consider these agents (lower-case); empty = everyone
 * @param {boolean} [opts.breakCountsAsOnline]
 */
export function summarize(agents, { watchEmails = [], breakCountsAsOnline = false } = {}) {
  if (!agents || !Array.isArray(agents.logoutCount) || !Array.isArray(agents.idleCount)) {
    throw new Error('Unexpected CallHippo response shape: data.agents is missing expected lists');
  }
  const byId = new Map((agents.finalArray || []).map((a) => [String(a._id), a]));
  const watch = new Set(watchEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const keep = (ids = []) =>
    ids.map(String).filter((id) => {
      if (watch.size === 0) return true;
      const email = (byId.get(id)?.email || '').toLowerCase();
      return watch.has(email);
    });

  const onCall = keep(agents.onCallCount);
  const idle = keep(agents.idleCount);
  const onBreak = keep(agents.breakCount);
  const offline = keep(agents.logoutCount);
  const online = [...onCall, ...idle, ...(breakCountsAsOnline ? onBreak : [])];
  const name = (id) => byId.get(id)?.fullName || id;

  // Watched emails CallHippo doesn't know about (typo, renamed, removed user).
  const known = new Set([...byId.values()].map((a) => (a.email || '').toLowerCase()));
  const unknownEmails = [...watch].filter((e) => !known.has(e));

  return {
    unknownEmails,
    onCall: onCall.length,
    idle: idle.length,
    onBreak: onBreak.length,
    offline: offline.length,
    online: online.length,
    onlineNames: online.map(name),
    breakNames: onBreak.map(name),
  };
}

/**
 * Decide what to post given the previous state and the confirmed current reading.
 * @returns {{ post: null | 'down' | 'up' | 'reminder', state: object }}
 */
export function decide(prev, isDown, now = Date.now(), reminderMinutes = 60) {
  const state = { ...prev };
  if (isDown && !prev.down) {
    state.down = true;
    state.downSince = now;
    state.lastNotified = now;
    return { post: 'down', state };
  }
  if (isDown && prev.down) {
    if (reminderMinutes > 0 && now - (prev.lastNotified || 0) >= reminderMinutes * 60_000) {
      state.lastNotified = now;
      return { post: 'reminder', state };
    }
    return { post: null, state };
  }
  if (!isDown && prev.down) {
    state.down = false;
    return { post: 'up', state: { ...state, downSince: prev.downSince } };
  }
  return { post: null, state: { ...state, down: false } };
}

export function minutesBetween(a, b) {
  return Math.max(0, Math.round((b - a) / 60_000));
}
