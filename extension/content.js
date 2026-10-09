(() => {
  function showToast(message) {
    let toast = document.getElementById('social-circle-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'social-circle-toast';
      toast.style.position = 'fixed';
      toast.style.top = '16px';
      toast.style.right = '16px';
      toast.style.zIndex = '1000000';
      toast.style.padding = '10px 14px';
      toast.style.borderRadius = '999px';
      toast.style.background = 'rgba(0,0,0,0.8)';
      toast.style.color = '#fff';
      toast.style.font = '12px/1.4 Arial, sans-serif';
      toast.style.boxShadow = '0 10px 24px rgba(0,0,0,0.2)';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    clearTimeout(showToast.timeoutId);
    showToast.timeoutId = setTimeout(() => {
      toast.remove();
    }, 2500);
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function buildHeaders(extra = {}) {
    const headers = {
      'x-ig-app-id': '936619743392459',
      'x-requested-with': 'XMLHttpRequest',
      ...extra,
    };
    const csrfToken = getCookie('csrftoken');
    if (csrfToken) headers['x-csrftoken'] = csrfToken;
    return headers;
  }

  async function fetchInstagramJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: buildHeaders(options.headers || {}),
    });

    if (!response.ok) {
      throw new Error(`Instagram request failed (${response.status}) for ${url}`);
    }

    return response.json();
  }

  // MV3 content scripts run in an isolated world, so window._sharedData and
  // other page globals are never visible here. The ds_user_id cookie (not
  // httpOnly) is the reliable way to get the logged-in user's pk.
  // The username is cached (scViewer) because users/{pk}/info/ is heavily
  // rate-limited and identity practically never changes.
  async function resolveViewer() {
    const pk = getCookie('ds_user_id');
    if (!pk) return null;

    const { scViewer, scFollowers, scEngagement } = await chrome.storage.local.get(
      ['scViewer', 'scFollowers', 'scEngagement'],
    );
    for (const cached of [scViewer, scFollowers?.viewer, scEngagement?.viewer]) {
      if (cached?.username && String(cached.pk) === pk) {
        await chrome.storage.local.set({ scViewer: { username: cached.username, pk } });
        return { username: cached.username, pk };
      }
    }

    try {
      const info = await fetchInstagramJson(`https://www.instagram.com/api/v1/users/${pk}/info/`);
      const username = info?.user?.username;
      if (username) {
        const viewer = { username, pk };
        await chrome.storage.local.set({ scViewer: viewer });
        return viewer;
      }
    } catch (error) {
      console.warn('[social-circle] users/info lookup failed', error);
      if (String(error?.message || '').includes('(429)')) {
        // soft 1h backoff: repeated clicks must not hammer a rate-limited endpoint
        await chrome.storage.local.set({ scCooldownUntil: Date.now() + 3600000 });
        throw new AccountSafetyError('Instagram is rate-limiting right now (429). Backing off for ~1h to protect your account. Try again later.');
      }
    }

    // Fallback: assume the viewer is on their own profile page
    const profileMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
    if (profileMatch) {
      const viewer = { username: profileMatch[1], pk };
      await chrome.storage.local.set({ scViewer: viewer });
      return viewer;
    }

    return null;
  }

  function fileNameFromUsername(username) {
    return `${(username || 'ig-social-circle').replace(/\s+/g, '-').toLowerCase()}.json`;
  }

  // ---------- Debug logging ----------
  // Toggled from the popup; events go to the page console AND a persistent
  // ring buffer (scDebugLog) exportable from the popup.
  let debugEnabled = false;
  chrome.storage.local.get('scDebug').then(({ scDebug }) => { debugEnabled = Boolean(scDebug); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scDebug) debugEnabled = Boolean(changes.scDebug.newValue);
  });

  const DEBUG_RING_MAX = 300;
  let debugQueue = Promise.resolve();
  function debugLog(event, details) {
    if (!debugEnabled) return;
    console.debug('[social-circle]', event, details);
    debugQueue = debugQueue
      .then(async () => {
        const { scDebugLog } = await chrome.storage.local.get('scDebugLog');
        const log = scDebugLog || [];
        log.push({ at: new Date().toISOString(), event, details });
        await chrome.storage.local.set({ scDebugLog: log.slice(-DEBUG_RING_MAX) });
      })
      .catch(() => {});
  }

  function shortUrl(url) {
    return (url || '').replace('https://www.instagram.com', '').slice(0, 120);
  }

  // ---------- Engagement collection (stories + posts) ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- Account-safety guard rails ----------
  // Goal: stay indistinguishable from a human browsing their own content and
  // stop IMMEDIATELY at the first anti-automation signal, never retrying.
  const SAFETY = {
    maxRequestsPerRun: 100,
    maxRequestsPerHour: 200,
    minDelayMs: 2000,
    jitterMs: 2500,
    longBreakEvery: 8,
    longBreakMs: [8000, 15000],
    cooldownMs: 24 * 3600 * 1000,
  };

  class AccountSafetyError extends Error {}

  let runRequestCount = 0;
  const resetRunBudget = () => { runRequestCount = 0; };

  async function assertNotCoolingDown() {
    const { scCooldownUntil } = await chrome.storage.local.get('scCooldownUntil');
    if (scCooldownUntil && Date.now() < scCooldownUntil) {
      const hours = Math.ceil((scCooldownUntil - Date.now()) / 3600000);
      throw new AccountSafetyError(`Instagram showed rate-limit signals recently; assisted crawling is paused ~${hours}h to protect your account. Passive capture still works.`);
    }
  }

  async function registerRequestOrThrow() {
    if (runRequestCount >= SAFETY.maxRequestsPerRun) {
      throw new AccountSafetyError('Per-run request budget reached. Progress is saved - run again later to resume.');
    }
    const hourAgo = Date.now() - 3600000;
    const { scRequestLog } = await chrome.storage.local.get('scRequestLog');
    const log = (scRequestLog || []).filter((t) => t > hourAgo);
    if (log.length >= SAFETY.maxRequestsPerHour) {
      throw new AccountSafetyError('Hourly request budget reached. Progress is saved - try again in an hour.');
    }
    log.push(Date.now());
    runRequestCount += 1;
    await chrome.storage.local.set({ scRequestLog: log });
  }

  async function waitUntilTabVisible() {
    while (document.visibilityState !== 'visible') {
      await sleep(1000);
    }
  }

  async function humanPause() {
    if (runRequestCount > 0 && runRequestCount % SAFETY.longBreakEvery === 0) {
      const [min, max] = SAFETY.longBreakMs;
      await sleep(min + Math.random() * (max - min));
    } else {
      await sleep(SAFETY.minDelayMs + Math.random() * SAFETY.jitterMs);
    }
  }

  async function tripSafetyFuse(reason) {
    debugLog('safety:fuse-tripped', { reason });
    await chrome.storage.local.set({ scCooldownUntil: Date.now() + SAFETY.cooldownMs });
    throw new AccountSafetyError(`Instagram anti-automation signal detected (${reason}). Stopped immediately and paused assisted crawling for 24h. Collected data is saved.`);
  }

  // Every assisted-crawl request must go through this wrapper.
  async function crawlFetch(url, options = {}) {
    await waitUntilTabVisible();
    await registerRequestOrThrow();
    await humanPause();

    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: buildHeaders(options.headers || {}),
    });

    debugLog('crawl:request', { url: shortUrl(url), method: options.method || 'GET', status: response.status, runCount: runRequestCount });

    if ([401, 403, 429].includes(response.status)) {
      await tripSafetyFuse(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (/challenge_required|checkpoint_required|feedback_required|login_required|please wait a few minutes/i.test(text)) {
      await tripSafetyFuse('challenge/feedback response');
    }

    if (!response.ok) {
      throw new Error(`Instagram request failed (${response.status}) for ${url}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      // HTML instead of JSON usually means a login/challenge interstitial
      await tripSafetyFuse('non-JSON response');
      return null;
    }
  }

  // Serialize read-modify-write cycles on chrome.storage to avoid races
  let storeQueue = Promise.resolve();
  function updateEngagementStore(mutator) {
    storeQueue = storeQueue
      .then(async () => {
        const { scEngagement } = await chrome.storage.local.get('scEngagement');
        const store = scEngagement || { viewer: null, posts: {}, stories: {}, updatedAt: null };
        mutator(store);
        store.updatedAt = new Date().toISOString();
        await chrome.storage.local.set({ scEngagement: store });
      })
      .catch((error) => console.warn('[social-circle] store update failed', error));
    return storeQueue;
  }

  function ensurePost(store, id) {
    if (!store.posts[id]) {
      store.posts[id] = { id, takenAt: null, code: null, caption: null, likeCount: null, commentCount: null, likers: {}, commenters: {}, commentIds: {} };
    }
    return store.posts[id];
  }

  function commentEntries(list) {
    return (Array.isArray(list) ? list : [])
      .map((c) => ({
        id: c?.pk ? String(c.pk) : null,
        username: c?.user?.username || c?.username,
        at: c?.created_at || c?.created_at_utc || null,
      }))
      .filter((c) => c.username);
  }

  // Dedupe by comment pk so passive + assisted captures never double-count;
  // keeps per-commenter timestamps for over-time analysis.
  function addComment(post, { id, username, at }) {
    if (!post.commentIds) post.commentIds = {};
    if (id) {
      if (post.commentIds[id]) return;
      post.commentIds[id] = true;
    }
    const current = post.commenters[username];
    const entry = typeof current === 'number'
      ? { count: current, times: [] }  // migrate pre-timestamp shape
      : (current || { count: 0, times: [] });
    entry.count += 1;
    if (at) entry.times.push(at);
    post.commenters[username] = entry;
  }

  function ensureStory(store, id) {
    if (!store.stories[id]) {
      store.stories[id] = { id, takenAt: null, viewers: {}, likers: {} };
    }
    return store.stories[id];
  }

  function usernamesFrom(list) {
    return (Array.isArray(list) ? list : [])
      .map((u) => u?.username || u?.user?.username)
      .filter(Boolean);
  }

  function normalizeMediaId(raw) {
    return raw ? String(raw).split('_')[0] : null;
  }

  function recordPostMeta(store, item) {
    const id = normalizeMediaId(item?.pk || item?.id);
    if (!id) return;
    const post = ensurePost(store, id);
    post.takenAt = item.taken_at ?? post.takenAt;
    post.code = item.code ?? post.code;
    post.caption = item.caption?.text?.slice(0, 120) ?? post.caption;
    post.likeCount = item.like_count ?? post.likeCount;
    post.commentCount = item.comment_count ?? post.commentCount;
  }

  // Instagram exposes no view timestamps; record when WE first saw the viewer.
  // The more often viewer lists are captured, the better the "view speed" bound.
  function addStoryViewer(story, username) {
    if (!(username in story.viewers) || story.viewers[username] === true) {
      story.viewers[username] = Math.floor(Date.now() / 1000);
    }
  }

  function recordStoryViewersPage(storyId, body, takenAt = null) {
    const viewers = usernamesFrom(body.users);
    const likersFromFlag = usernamesFrom((body.users || []).filter((u) => u?.has_liked));
    const likersFromMedia = usernamesFrom(body.updated_media?.likers);
    return updateEngagementStore((store) => {
      const story = ensureStory(store, storyId);
      story.takenAt = takenAt ?? body.updated_media?.taken_at ?? story.takenAt;
      viewers.forEach((u) => addStoryViewer(story, u));
      likersFromFlag.concat(likersFromMedia).forEach((u) => { story.likers[u] = true; });
    });
  }

  function parseGraphqlMediaId(requestBody) {
    if (typeof requestBody !== 'string') return null;
    try {
      const vars = new URLSearchParams(requestBody).get('variables');
      const parsed = vars ? JSON.parse(vars) : null;
      return normalizeMediaId(parsed?.media_id || parsed?.mediaID || parsed?.media_pk);
    } catch {
      return null;
    }
  }

  // Best-effort parsing of modern GraphQL (doc_id) responses captured passively
  function ingestGraphqlCapture(capture, body) {
    const data = body?.data;
    if (!data || typeof data !== 'object') {
      debugLog('graphql:no-data', { url: shortUrl(capture.url) });
      return;
    }
    const mediaId = parseGraphqlMediaId(capture.requestBody);
    let matched = false;

    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') continue;
      const keyName = key.toLowerCase();

      // Own posts timeline now ships via GraphQL (xdt_api__v1__feed__user_timeline_...)
      if (keyName.includes('timeline') && Array.isArray(value.edges)) {
        const items = value.edges.map((e) => e?.node).filter(Boolean);
        if (items.length) {
          matched = true;
          debugLog('ingest:graphql-timeline', { key, items: items.length });
          updateEngagementStore((store) => items.forEach((item) => recordPostMeta(store, item)));
        }
        continue;
      }

      if (keyName.includes('reels_media')) {
        const reels = Array.isArray(value) ? value : (value.reels_media || []);
        if (reels.length) {
          matched = true;
          debugLog('ingest:graphql-reels', { key, reels: reels.length });
          updateEngagementStore((store) => {
            reels.forEach((reel) => (reel?.items || []).forEach((item) => {
              const id = normalizeMediaId(item?.pk || item?.id);
              if (!id) return;
              const story = ensureStory(store, id);
              story.takenAt = item.taken_at ?? story.takenAt;
            }));
          });
        }
        continue;
      }

      if (!mediaId) continue;
      const users = usernamesFrom(value.users);
      const comments = commentEntries(value.comments);

      if (users.length && keyName.includes('liker')) {
        matched = true;
        debugLog('ingest:graphql-likers', { mediaId, key, users: users.length });
        updateEngagementStore((store) => {
          const post = ensurePost(store, mediaId);
          users.forEach((u) => { post.likers[u] = true; });
        });
      } else if (users.length && keyName.includes('viewer')) {
        matched = true;
        debugLog('ingest:graphql-viewers', { mediaId, key, users: users.length });
        updateEngagementStore((store) => {
          const story = ensureStory(store, mediaId);
          users.forEach((u) => addStoryViewer(story, u));
        });
      } else if (comments.length && keyName.includes('comment')) {
        matched = true;
        debugLog('ingest:graphql-comments', { mediaId, key, comments: comments.length });
        updateEngagementStore((store) => {
          const post = ensurePost(store, mediaId);
          comments.forEach((c) => addComment(post, c));
        });
      }
    }
    if (!matched) {
      // key names here reveal endpoint changes to adapt the parser to
      debugLog('graphql:unmatched', { mediaId, keys: Object.keys(data) });
    }
  }

  // Passive followers: merge list pages the user scrolls through manually.
  // Own-account check prevents polluting state with other people's follower lists.
  let followersQueue = Promise.resolve();
  function mergePassiveFollowers(users) {
    followersQueue = followersQueue
      .then(async () => {
        const { scFollowers } = await chrome.storage.local.get('scFollowers');
        const state = scFollowers || { viewer: null, maxId: null, done: false, followers: {}, snapshotSaved: false, updatedAt: null };
        users.forEach((u) => {
          if (!u?.username) return;
          const existing = state.followers[u.username];
          const entry = existing && typeof existing === 'object' ? existing : { pk: null, following: null };
          entry.pk = u.pk ? String(u.pk) : entry.pk;
          if (typeof u.friendship_status?.following === 'boolean') {
            entry.following = u.friendship_status.following;
          }
          state.followers[u.username] = entry;
        });
        state.updatedAt = new Date().toISOString();
        await chrome.storage.local.set({ scFollowers: state });
      })
      .catch((error) => console.warn('[social-circle] passive followers merge failed', error));
    return followersQueue;
  }

  function ingestCapture(capture) {
    let body;
    try {
      body = JSON.parse(capture.body);
    } catch {
      debugLog('ingest:non-json', { url: shortUrl(capture.url), snippet: String(capture.body).slice(0, 200) });
      return;
    }
    const url = capture.url || '';

    const friendshipsMatch = url.match(/\/api\/v1\/friendships\/(\d+)\/(followers|following)\//);
    if (friendshipsMatch) {
      const ownList = friendshipsMatch[1] === getCookie('ds_user_id');
      if (ownList && friendshipsMatch[2] === 'followers' && Array.isArray(body.users)) {
        debugLog('ingest:followers', { users: body.users.length, hasNext: Boolean(body.next_max_id) });
        mergePassiveFollowers(body.users);
      } else {
        debugLog('ingest:friendships-skipped', { url: shortUrl(url), ownList });
      }
      return;
    }

    const mediaIdMatch = url.match(/\/api\/v1\/media\/([^/]+)\//);
    const mediaId = mediaIdMatch ? normalizeMediaId(mediaIdMatch[1]) : null;

    if (mediaId && url.includes('list_reel_media_viewer')) {
      debugLog('ingest:story-viewers', { mediaId, viewers: body.users?.length ?? 0, hasNext: Boolean(body.next_max_id) });
      recordStoryViewersPage(mediaId, body);
      return;
    }

    if (mediaId && url.includes('/likers/')) {
      const likers = usernamesFrom(body.users);
      debugLog('ingest:post-likers', { mediaId, likers: likers.length });
      updateEngagementStore((store) => {
        const post = ensurePost(store, mediaId);
        likers.forEach((u) => { post.likers[u] = true; });
      });
      return;
    }

    if (mediaId && url.includes('/comments/')) {
      const entries = commentEntries(body.comments);
      debugLog('ingest:post-comments', { mediaId, comments: entries.length, hasNext: Boolean(body.next_min_id) });
      updateEngagementStore((store) => {
        const post = ensurePost(store, mediaId);
        entries.forEach((c) => addComment(post, c));
      });
      return;
    }

    if (/\/api\/v1\/feed\/user\//.test(url) && Array.isArray(body.items)) {
      debugLog('ingest:feed-posts', { items: body.items.length, hasNext: Boolean(body.next_max_id) });
      updateEngagementStore((store) => {
        body.items.forEach((item) => recordPostMeta(store, item));
      });
      return;
    }

    if (url.includes('/feed/reels_media')) {
      const reels = body.reels_media || Object.values(body.reels || {});
      debugLog('ingest:reels-media', { reels: Array.isArray(reels) ? reels.length : 0 });
      updateEngagementStore((store) => {
        (Array.isArray(reels) ? reels : []).forEach((reel) => {
          (reel?.items || []).forEach((item) => {
            const id = normalizeMediaId(item?.pk || item?.id);
            if (!id) return;
            const story = ensureStory(store, id);
            story.takenAt = item.taken_at ?? story.takenAt;
          });
        });
      });
      return;
    }

    if (url.includes('/graphql/query')) {
      ingestGraphqlCapture(capture, body);
      return;
    }

    debugLog('ingest:unmatched', { url: shortUrl(url) });
  }

  // Passive mode: receive payloads mirrored by interceptor.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__socialCircle !== true) return;
    try {
      ingestCapture(event.data);
    } catch (error) {
      console.warn('[social-circle] failed to ingest capture', error);
    }
  });

  // Assisted mode: slowly crawl own posts (last year) + live stories.
  // Respects per-run/per-hour budgets and resumes where it left off.
  async function collectEngagement() {
    await assertNotCoolingDown();
    resetRunBudget();

    const viewer = await resolveViewer();
    if (!viewer || !viewer.username || !viewer.pk) {
      throw new Error('Unable to find your Instagram profile data. Make sure you are signed in.');
    }
    await updateEngagementStore((store) => { store.viewer = viewer; });

    const cutoff = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
    const postIds = [];
    let maxId = null;
    let reachedCutoff = false;

    showToast('Collecting your posts from the last year...');
    try {
      while (!reachedCutoff) {
        const params = new URLSearchParams({ count: '33' });
        if (maxId) params.set('max_id', maxId);
        const feed = await crawlFetch(`https://www.instagram.com/api/v1/feed/user/${viewer.pk}/?${params}`);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        if (!items.length) break;

        await updateEngagementStore((store) => items.forEach((item) => recordPostMeta(store, item)));
        for (const item of items) {
          if (item.taken_at && item.taken_at < cutoff) {
            reachedCutoff = true;
            break;
          }
          postIds.push(normalizeMediaId(item.pk || item.id));
        }
        maxId = feed?.next_max_id || null;
        if (!maxId || feed?.more_available === false) break;
      }

      // Resume support: skip posts already fully collected in a previous run
      const { scEngagement: existing } = await chrome.storage.local.get('scEngagement');
      const pending = postIds.filter((id) => !existing?.posts?.[id]?.collectedAt);

      let done = 0;
      for (const postId of pending) {
        const likersResp = await crawlFetch(`https://www.instagram.com/api/v1/media/${postId}/likers/`);
        await updateEngagementStore((store) => {
          const post = ensurePost(store, postId);
          usernamesFrom(likersResp.users).forEach((u) => { post.likers[u] = true; });
        });

        let minId = null;
        for (let page = 0; page < 4; page += 1) {
          const params = new URLSearchParams({ can_support_threading: 'true' });
          if (minId) params.set('min_id', minId);
          const commentsResp = await crawlFetch(`https://www.instagram.com/api/v1/media/${postId}/comments/?${params}`);
          await updateEngagementStore((store) => {
            const post = ensurePost(store, postId);
            commentEntries(commentsResp.comments).forEach((c) => addComment(post, c));
          });
          minId = commentsResp?.next_min_id || null;
          if (!minId) break;
        }

        await updateEngagementStore((store) => {
          ensurePost(store, postId).collectedAt = new Date().toISOString();
        });
        done += 1;
        showToast(`Posts processed: ${done}/${pending.length}`);
      }

      // Live stories: viewer lists only exist while a story is active (~24-48h)
      showToast('Collecting live story viewers...');
      const reels = await crawlFetch(`https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${viewer.pk}`);
      const items = reels?.reels?.[viewer.pk]?.items
        || (Array.isArray(reels?.reels_media) ? reels.reels_media[0]?.items : null)
        || [];
      for (const item of items) {
        const storyId = normalizeMediaId(item.pk || item.id);
        if (!storyId) continue;
        let storyMaxId = null;
        do {
          const params = new URLSearchParams({ count: '50' });
          if (storyMaxId) params.set('max_id', storyMaxId);
          const viewersResp = await crawlFetch(`https://www.instagram.com/api/v1/media/${storyId}/list_reel_media_viewer/?${params}`);
          await recordStoryViewersPage(storyId, viewersResp, item.taken_at ?? null);
          storyMaxId = viewersResp?.next_max_id || null;
        } while (storyMaxId);
      }
    } catch (error) {
      // Budget/cooldown stops are expected: progress is saved, surface gently
      if (!(error instanceof AccountSafetyError)) throw error;
      showToast(error.message);
      console.warn('[social-circle]', error.message);
    }

    await storeQueue;
    const { scEngagement } = await chrome.storage.local.get('scEngagement');
    const summary = {
      posts: Object.keys(scEngagement?.posts || {}).length,
      stories: Object.keys(scEngagement?.stories || {}).length,
    };
    showToast(`Engagement collected: ${summary.posts} posts, ${summary.stories} stories.`);
    return summary;
  }

  // Followers collection persists its cursor (scFollowers) so each run
  // continues where the previous one stopped; export always contains
  // everything collected so far.
  async function collectFollowersGraph() {
    await assertNotCoolingDown();
    resetRunBudget();

    const viewer = await resolveViewer();
    if (!viewer || !viewer.username || !viewer.pk) {
      throw new Error('Unable to find your Instagram profile data. Please make sure you are signed in to Instagram and the page has fully loaded.');
    }

    let { scFollowers: state } = await chrome.storage.local.get('scFollowers');
    // Fresh start if no state, a different account, or previous collection finished.
    // Imported state may lack pk - adopt it for the current viewer.
    // followers[u] = { pk, following: true|false|null } (null = status not resolved yet)
    const hasUnresolved = (s) => Object.values(s?.followers || {})
      .some((v) => v && typeof v === 'object' && v.pk && v.following == null);
    const isComplete = (s) => Boolean(s?.done) && !hasUnresolved(s);
    if (!state || isComplete(state) || (state.viewer?.pk && state.viewer.pk !== viewer.pk)) {
      state = { viewer, maxId: null, done: false, followers: {}, snapshotSaved: false, updatedAt: null };
    } else {
      state.viewer = viewer;
      state.snapshotSaved = state.snapshotSaved || false;
    }

    const perRunLimit = 500;
    const pageSize = 50;
    let processedThisRun = 0;
    const alreadyCollected = Object.keys(state.followers).length;

    showToast(alreadyCollected
      ? `Resuming followers collection (${alreadyCollected} already collected)...`
      : `Collecting ${viewer.username}'s followers...`);

    const saveState = async () => {
      state.updatedAt = new Date().toISOString();
      await chrome.storage.local.set({ scFollowers: state });
    };

    try {
      while (!state.done && processedThisRun < perRunLimit) {
        const params = new URLSearchParams({
          count: String(pageSize),
          search_surface: 'follow_list_page',
        });
        if (state.maxId) params.set('max_id', state.maxId);

        const url = `https://www.instagram.com/api/v1/friendships/${viewer.pk}/followers/?${params}`;
        const response = await crawlFetch(url);
        console.debug('[social-circle] followers page', { maxId: state.maxId, response });

        const users = Array.isArray(response?.users) ? response.users : [];
        if (response?.status !== 'ok' && users.length === 0) {
          throw new Error(`Unexpected followers response: ${JSON.stringify(response).slice(0, 300)}`);
        }

        for (const follower of users) {
          if (!follower?.username) continue;
          const existing = state.followers[follower.username];
          const entry = existing && typeof existing === 'object' ? existing : { pk: null, following: null };
          entry.pk = follower.pk ? String(follower.pk) : entry.pk;
          // Follow-back status ships with the list itself (the "Follow" button in the UI)
          if (typeof follower.friendship_status?.following === 'boolean') {
            entry.following = follower.friendship_status.following;
          } else if (typeof follower.is_following === 'boolean') {
            entry.following = follower.is_following;
          }
          state.followers[follower.username] = entry;
          processedThisRun += 1;
        }

        state.maxId = response?.next_max_id || null;
        state.done = !state.maxId || users.length === 0;
        await saveState();

        showToast(`Collected ${Object.keys(state.followers).length} followers...`);
      }

      // Resolve missing follow-back statuses in batches - far cheaper than
      // walking the entire following list (same call the UI uses for buttons).
      const unresolved = () => Object.entries(state.followers)
        .filter(([, v]) => v && typeof v === 'object' && v.pk && v.following == null);
      const BATCH = 100;
      while (state.done && unresolved().length > 0 && processedThisRun < perRunLimit) {
        const batch = unresolved().slice(0, BATCH);
        const body = new URLSearchParams({ user_ids: batch.map(([, v]) => v.pk).join(',') });
        const resp = await crawlFetch('https://www.instagram.com/api/v1/friendships/show_many/', {
          method: 'POST',
          body: body.toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        const statuses = resp?.friendship_statuses || {};
        for (const [username, entry] of batch) {
          const status = statuses[entry.pk];
          // mark resolved even if absent, to avoid re-requesting forever
          entry.following = typeof status?.following === 'boolean' ? status.following : false;
          state.followers[username] = entry;
        }
        processedThisRun += batch.length;
        await saveState();
        showToast(`Resolved follow-back status for ${Object.values(state.followers).filter((v) => v?.following != null).length} followers...`);
      }
    } catch (error) {
      // Budget/cooldown stop: cursor is saved, export the partial result
      if (!(error instanceof AccountSafetyError)) throw error;
      showToast(error.message);
      console.warn('[social-circle]', error.message);
    }

    // Snapshot once per completed collection; history powers churn analysis
    let snapshots = [];
    try {
      const { scFollowerSnapshots } = await chrome.storage.local.get('scFollowerSnapshots');
      snapshots = scFollowerSnapshots || [];
      if (isComplete(state) && !state.snapshotSaved) {
        snapshots.push({
          at: new Date().toISOString(),
          followers: Object.keys(state.followers),
          notFollowedBack: Object.entries(state.followers)
            .filter(([, v]) => v?.following === false)
            .map(([u]) => u),
        });
        snapshots = snapshots.slice(-12);
        await chrome.storage.local.set({ scFollowerSnapshots: snapshots });
        state.snapshotSaved = true;
        await saveState();
      }
    } catch (error) {
      console.warn('[social-circle] snapshot save failed', error);
    }

    const followerNames = Object.keys(state.followers);
    const unresolvedCount = Object.values(state.followers)
      .filter((v) => !v || typeof v !== 'object' || v.following == null).length;

    // Churn vs the previous completed snapshot
    let changes = null;
    if (snapshots.length >= 2) {
      const prev = snapshots[snapshots.length - 2];
      const last = snapshots[snapshots.length - 1];
      const prevSet = new Set(prev.followers);
      const lastSet = new Set(last.followers);
      changes = {
        since: prev.at,
        gained: last.followers.filter((u) => !prevSet.has(u)),
        lost: prev.followers.filter((u) => !lastSet.has(u)),
      };
    }

    const graph = {
      username: viewer.username,
      metadata: {
        loggedUserFetched: true,
        source: 'browser-extension',
        lastRun: new Date().toISOString(),
        complete: isComplete(state),
        followersCollected: followerNames.length,
        followBackUnresolved: unresolvedCount,
      },
      analysis: {
        notFollowedBack: state.done && unresolvedCount === 0
          ? followerNames.filter((u) => state.followers[u]?.following === false)
          : null,                       // null = statuses incomplete, diff unreliable
        changes,
      },
      nodes: [
        { id: viewer.username, group: 1 },
        ...followerNames.map((username) => ({ id: username, group: 1 })),
      ],
      links: followerNames.map((username) => ({
        source: username,
        target: viewer.username,
        value: 1,
      })),
    };

    showToast(isComplete(state)
      ? `Done! ${followerNames.length} followers collected.`
      : `Partial export: ${followerNames.length} followers so far. Run again to continue.`);
    return graph;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'collectGraph') {
      (async () => {
        try {
          const graph = await collectFollowersGraph();
          sendResponse({ ok: true, data: graph, filename: fileNameFromUsername(graph.username) });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error while collecting graph',
          });
        }
      })();
      return true;
    }

    if (message?.type === 'collectEngagement') {
      (async () => {
        try {
          const summary = await collectEngagement();
          sendResponse({ ok: true, summary });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error while collecting engagement',
          });
        }
      })();
      return true;
    }
  });
})();
