const setStatus = (message, isError = false) => {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
};

const runCollection = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    setStatus('No active Instagram tab found.', true);
    return;
  }

  try {
    setStatus('Collecting graph...');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'collectGraph' });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'Unable to collect graph.');
    }

    const blob = new Blob([JSON.stringify(response.data, null, 2)], {
      type: 'application/json',
    });

    const fileUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: fileUrl,
      filename: response.filename || 'ig-social-circle.json',
      saveAs: true,
    });

    setStatus('Graph downloaded.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to collect graph.', true);
  }
};

const openInstagramTab = () => {
  chrome.tabs.create({ url: 'https://www.instagram.com' });
};

// ---------- Engagement ----------

const WEIGHTS = { postLike: 1, comment: 2, storyView: 0.5, storyLike: 1.5 };

const computeRanking = (store) => {
  const stats = {};
  const bump = (username, field, amount = 1) => {
    if (!username || username === store?.viewer?.username) return null;
    if (!stats[username]) {
      stats[username] = { username, postLikes: 0, comments: 0, storyViews: 0, storyLikes: 0, _delaySum: 0, _delayN: 0 };
    }
    stats[username][field] += amount;
    return stats[username];
  };

  Object.values(store?.posts || {}).forEach((post) => {
    Object.keys(post.likers || {}).forEach((u) => bump(u, 'postLikes'));
    Object.entries(post.commenters || {}).forEach(([u, c]) => {
      const count = typeof c === 'number' ? c : (c?.count || 0);
      bump(u, 'comments', count);
    });
  });
  Object.values(store?.stories || {}).forEach((story) => {
    Object.entries(story.viewers || {}).forEach(([u, seenAt]) => {
      const entry = bump(u, 'storyViews');
      // seenAt === true is legacy data without a first-seen timestamp
      if (entry && story.takenAt && typeof seenAt === 'number' && seenAt >= story.takenAt) {
        entry._delaySum += seenAt - story.takenAt;
        entry._delayN += 1;
      }
    });
    Object.keys(story.likers || {}).forEach((u) => bump(u, 'storyLikes'));
  });

  return Object.values(stats)
    .map(({ _delaySum, _delayN, ...s }) => ({
      ...s,
      // upper bound: viewed within this many hours of posting (depends on capture frequency)
      avgStoryViewDelayHours: _delayN ? Number((_delaySum / _delayN / 3600).toFixed(2)) : null,
      score: Number((
        s.postLikes * WEIGHTS.postLike
        + s.comments * WEIGHTS.comment
        + s.storyViews * WEIGHTS.storyView
        + s.storyLikes * WEIGHTS.storyLike
      ).toFixed(2)),
    }))
    .sort((a, b) => b.score - a.score);
};

const refreshEngagementStats = async () => {
  const el = document.getElementById('engagement-stats');
  if (!el) return;
  const { scEngagement } = await chrome.storage.local.get('scEngagement');
  if (!scEngagement) {
    el.textContent = 'No engagement data yet.';
    return;
  }
  const posts = Object.keys(scEngagement.posts || {}).length;
  const stories = Object.keys(scEngagement.stories || {}).length;
  const people = computeRanking(scEngagement).length;
  el.textContent = `${posts} posts, ${stories} stories, ${people} people tracked (updated ${scEngagement.updatedAt || 'n/a'}).`;
};

const runEngagementCollection = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus('No active Instagram tab found.', true);
    return;
  }

  try {
    setStatus('Collecting engagement... progress is shown on the Instagram page; you can close this popup.');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'collectEngagement' });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'Unable to collect engagement.');
    }
    setStatus(`Done: ${response.summary.posts} posts, ${response.summary.stories} stories.`);
    await refreshEngagementStats();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to collect engagement.', true);
  }
};

const exportEngagement = async () => {
  const { scEngagement } = await chrome.storage.local.get('scEngagement');
  if (!scEngagement) {
    setStatus('No engagement data collected yet.', true);
    return;
  }

  const payload = {
    ...scEngagement,
    weights: WEIGHTS,
    ranking: computeRanking(scEngagement),
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const fileUrl = URL.createObjectURL(blob);
  const username = scEngagement.viewer?.username || 'ig';
  await chrome.downloads.download({
    url: fileUrl,
    filename: `${username}-engagement.json`,
    saveAs: true,
  });
  setStatus('Engagement data downloaded.');
};

const clearEngagement = async () => {
  await chrome.storage.local.remove('scEngagement');
  await refreshEngagementStats();
  setStatus('Engagement data cleared.');
};

// ---------- Import previous exports (merge into storage) ----------

const mergeCommenters = (target, source) => {
  Object.entries(source || {}).forEach(([u, c]) => {
    const src = typeof c === 'number' ? { count: c, times: [] } : (c || { count: 0, times: [] });
    const curRaw = target[u];
    const cur = typeof curRaw === 'number' ? { count: curRaw, times: [] } : (curRaw || { count: 0, times: [] });
    target[u] = {
      count: Math.max(cur.count, src.count),
      times: [...new Set([...(cur.times || []), ...(src.times || [])])],
    };
  });
};

const importExportFile = async (file) => {
  const data = JSON.parse(await file.text());

  // Followers graph export: seed the resumable followers set
  if (data.username && Array.isArray(data.nodes)) {
    const { scFollowers } = await chrome.storage.local.get('scFollowers');
    const state = scFollowers || { viewer: null, maxId: null, done: false, followers: {}, updatedAt: null };
    data.nodes.forEach((node) => {
      if (node?.id && node.id !== data.username && !state.followers[node.id]) {
        state.followers[node.id] = { pk: null, following: null };
      }
    });
    if (!state.viewer) state.viewer = { username: data.username, pk: null };
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ scFollowers: state });
    setStatus(`Merged followers graph: ${Object.keys(state.followers).length} followers in storage.`);
    return;
  }

  // Engagement export: merge posts/stories
  if (data.posts || data.stories) {
    const { scEngagement } = await chrome.storage.local.get('scEngagement');
    const store = scEngagement || { viewer: null, posts: {}, stories: {}, updatedAt: null };
    store.viewer = store.viewer || data.viewer || null;

    Object.entries(data.posts || {}).forEach(([id, src]) => {
      const post = store.posts[id] || { id, takenAt: null, code: null, caption: null, likeCount: null, commentCount: null, likers: {}, commenters: {}, commentIds: {} };
      post.takenAt = post.takenAt ?? src.takenAt;
      post.code = post.code ?? src.code;
      post.caption = post.caption ?? src.caption;
      post.likeCount = src.likeCount ?? post.likeCount;
      post.commentCount = src.commentCount ?? post.commentCount;
      post.collectedAt = post.collectedAt || src.collectedAt;
      Object.keys(src.likers || {}).forEach((u) => { post.likers[u] = true; });
      Object.keys(src.commentIds || {}).forEach((cid) => { post.commentIds[cid] = true; });
      mergeCommenters(post.commenters, src.commenters);
      store.posts[id] = post;
    });

    Object.entries(data.stories || {}).forEach(([id, src]) => {
      const story = store.stories[id] || { id, takenAt: null, viewers: {}, likers: {} };
      story.takenAt = story.takenAt ?? src.takenAt;
      Object.entries(src.viewers || {}).forEach(([u, seenAt]) => {
        const cur = story.viewers[u];
        // keep the earliest first-seen timestamp; numbers beat legacy `true`
        if (typeof seenAt === 'number' && (typeof cur !== 'number' || seenAt < cur)) {
          story.viewers[u] = seenAt;
        } else if (!(u in story.viewers)) {
          story.viewers[u] = seenAt;
        }
      });
      Object.keys(src.likers || {}).forEach((u) => { story.likers[u] = true; });
      store.stories[id] = story;
    });

    store.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ scEngagement: store });
    await refreshEngagementStats();
    setStatus('Engagement export merged into storage.');
    return;
  }

  setStatus('Unrecognized JSON format (expected a graph or engagement export).', true);
};

document.getElementById('collect')?.addEventListener('click', runCollection);
document.getElementById('open-instagram')?.addEventListener('click', openInstagramTab);
document.getElementById('collect-engagement')?.addEventListener('click', runEngagementCollection);
document.getElementById('export-engagement')?.addEventListener('click', exportEngagement);
document.getElementById('clear-engagement')?.addEventListener('click', clearEngagement);
document.getElementById('import-data')?.addEventListener('click', () => {
  document.getElementById('import-file')?.click();
});
document.getElementById('import-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await importExportFile(file);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Import failed.', true);
  }
  event.target.value = '';
});

// ---------- Debug ----------

const refreshDebugStats = async () => {
  const el = document.getElementById('debug-stats');
  if (!el) return;
  const { scDebug, scDebugLog, scRequestLog, scCooldownUntil } = await chrome.storage.local.get(
    ['scDebug', 'scDebugLog', 'scRequestLog', 'scCooldownUntil'],
  );
  const toggle = document.getElementById('debug-toggle');
  if (toggle) toggle.checked = Boolean(scDebug);

  const hourAgo = Date.now() - 3600000;
  const requestsLastHour = (scRequestLog || []).filter((t) => t > hourAgo).length;
  const cooldown = scCooldownUntil && Date.now() < scCooldownUntil
    ? ` COOLDOWN until ${new Date(scCooldownUntil).toLocaleTimeString()}.`
    : '';
  el.textContent = `${(scDebugLog || []).length} log entries. ${requestsLastHour}/200 requests last hour.${cooldown}`;
};

document.getElementById('debug-toggle')?.addEventListener('change', async (event) => {
  await chrome.storage.local.set({ scDebug: event.target.checked });
  setStatus(event.target.checked ? 'Debug mode ON - browse Instagram and check the log.' : 'Debug mode off.');
});

document.getElementById('export-debug')?.addEventListener('click', async () => {
  const { scDebugLog } = await chrome.storage.local.get('scDebugLog');
  if (!scDebugLog?.length) {
    setStatus('Debug log is empty. Enable debug mode and browse Instagram first.', true);
    return;
  }
  const blob = new Blob([JSON.stringify(scDebugLog, null, 2)], { type: 'application/json' });
  await chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: 'social-circle-debug.json',
    saveAs: true,
  });
  setStatus('Debug log downloaded.');
});

document.getElementById('clear-debug')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('scDebugLog');
  await refreshDebugStats();
  setStatus('Debug log cleared.');
});

refreshEngagementStats();
refreshDebugStats();
