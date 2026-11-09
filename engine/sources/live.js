// Live mode: polls a JSON URL every 3 s. Reads only: this file never sends anything but GET.
// Takes a plain list, { events: [...] }, { data: [...] }, or the Supabase REST shape.

export const POLL_SECONDS = 3;
const MAX_BACKOFF_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10000;
const LOOKBACK_MS = 14 * 24 * 3600 * 1000;
const CATCHUP_AGE_MS = 30 * 1000;
const SKIP_NOTICE_SECONDS = 20;

export function isSupabaseUrl(url) {
  return /\/rest\/v1\//.test(url);
}

// Supabase returns at most 1000 rows by default, so ask for the newest, and from the cursor on.
export function buildPollUrl(url, cursorMs) {
  if (!isSupabaseUrl(url)) return url;
  const u = new URL(url, 'http://local.invalid');
  if (!u.searchParams.has('select')) u.searchParams.set('select', 'id,bot_id,type,text,timestamp,value');
  if (!u.searchParams.has('order')) u.searchParams.set('order', 'timestamp.desc');
  if (!u.searchParams.has('limit')) u.searchParams.set('limit', '1000');
  // gte, not gt: two rows can share a timestamp. Repeats are dropped by the store.
  u.searchParams.set('timestamp', `gte.${new Date(cursorMs).toISOString()}`);
  const text = u.toString();
  return text.startsWith('http://local.invalid') ? text.slice('http://local.invalid'.length) : text;
}

export function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

export function readHeaders(url, anonKey) {
  const headers = { Accept: 'application/json' };
  if (anonKey && isSupabaseUrl(url)) {
    headers.apikey = anonKey;
    // New publishable keys are not JWTs and are refused as a bearer token.
    if (anonKey.split('.').length === 3) headers.Authorization = `Bearer ${anonKey}`;
  }
  return headers;
}

export function nextBackoff(previous) {
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(POLL_SECONDS, previous) * 2);
}

export function createLiveSource({ store, url, anonKey, now, fetchImpl = (...a) => fetch(...a) }) {
  let wait = 0; // Poll at once on the first update.
  let backoff = POLL_SECONDS;
  let inFlight = false;
  let disposed = false;
  let firstPollDone = false;
  let cursorMs = now() - LOOKBACK_MS;
  let state = 'connecting';
  let lastError = '';
  let failures = 0;
  let controller = null;
  let skipNoticeLeft = 0;
  let skippedSeen = 0;

  function fail(message) {
    failures += 1;
    backoff = failures === 1 ? POLL_SECONDS * 2 : nextBackoff(backoff);
    wait = backoff;
    state = 'retrying';
    lastError = message;
  }

  async function poll() {
    inFlight = true;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(buildPollUrl(url, cursorMs), {
        method: 'GET',
        headers: readHeaders(url, anonKey),
        cache: 'no-store',
        signal: controller?.signal,
      });
      if (disposed) return;
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? ', check the anon key and the read policy' : '';
        fail(`HTTP ${res.status}${hint}`);
        return;
      }
      let body;
      try {
        body = await res.json();
      } catch {
        fail('the answer is not JSON');
        return;
      }
      if (disposed) return;
      const rows = extractRows(body);
      if (!rows) {
        fail('the answer is not a list of events');
        return;
      }
      const nowMs = now();
      const isFirst = !firstPollDone;
      store.ingestBatch(rows, (row) => {
        if (isFirst) return { catchup: true };
        const ms = row && Date.parse(row.timestamp);
        return { catchup: Number.isFinite(ms) && nowMs - ms > CATCHUP_AGE_MS };
      });
      let newest = cursorMs;
      for (const row of rows) {
        const ms = row && Date.parse(row.timestamp);
        if (Number.isFinite(ms) && ms > newest && ms <= nowMs + 60000) newest = ms;
      }
      cursorMs = newest;
      firstPollDone = true;
      failures = 0;
      backoff = POLL_SECONDS;
      wait = POLL_SECONDS;
      state = 'ok';
      lastError = '';
    } catch (err) {
      if (disposed) return;
      fail(err?.name === 'AbortError' ? 'the server took too long' : 'cannot reach the server');
    } finally {
      if (timer) clearTimeout(timer);
      inFlight = false;
    }
  }

  return {
    mode: 'live',
    now,
    start() {},
    update(dt) {
      // A skipped row gets a notice for a while, not for ever on a public page. The console keeps the detail.
      if (store.rejected !== skippedSeen) {
        skippedSeen = store.rejected;
        skipNoticeLeft = SKIP_NOTICE_SECONDS;
      }
      skipNoticeLeft = Math.max(0, skipNoticeLeft - dt);
      if (disposed || inFlight) return;
      wait -= dt;
      if (wait <= 0) poll();
    },
    status() {
      if (state === 'retrying') {
        const secs = Math.max(0, Math.ceil(wait));
        return { state: 'retrying', label: 'offline', detail: `${lastError}. Retrying in ${secs} s` };
      }
      if (state === 'connecting') return { state: 'connecting', label: 'connecting', detail: '' };
      if (store.rejected && (skipNoticeLeft > 0 || store.rejected !== skippedSeen)) {
        return { state: 'warn', label: 'live', detail: `${store.rejected} row${store.rejected > 1 ? 's' : ''} skipped: ${store.lastProblem}` };
      }
      return { state: 'ok', label: 'live', detail: '' };
    },
    // For tests.
    get backoffSeconds() {
      return backoff;
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
