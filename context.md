# Project Context & Decision Log

Living document for the `browser-extension` branch. Update when architectural decisions are made.

## Goal

A local browser extension that collects your own Instagram social data — followers,
post engagement, story viewers — and exports JSON for analysis in external tools.
(Originally a fork of a Next.js graph visualizer; the entire web app was removed in
decision #20 — the extension and its exports are the whole product now.)

## Decision log

| # | Decision | Why |
|---|----------|-----|
| 1 | Replace GitHub-Pages bookmarklet with a local MV3 extension | Instagram blocks third-party-hosted scripts; a local extension runs with the user's own session and nothing is hosted publicly. |
| 2 | Get viewer identity from `ds_user_id` cookie + `/api/v1/users/{pk}/info/` | MV3 content scripts run in an **isolated world** — `window._sharedData` and page globals are invisible. The cookie is not httpOnly and is the only reliable viewer source. |
| 3 | Drop GraphQL `query_hash` endpoints; use the web REST API (`/api/v1/...`) | The old `query_hash` GraphQL endpoint is dead (returned empty graphs). The REST API is what instagram.com itself calls today. |
| 4 | **Hybrid collection: passive capture (primary) + assisted crawl (secondary)** | Passive = zero detection risk (only mirrors responses the page already received). Assisted = convenience for bulk post history, kept slow and budgeted. Official alternatives are dead ends: the DYI export has no "who liked/viewed me" data; the Graph API gives aggregate counts without identities. |
| 5 | Passive capture via a MAIN-world content script patching `fetch`/XHR | MV3's `world: "MAIN"` lets us see page responses without `chrome.debugger` (scary banner) and without extra requests. |
| 6 | Account-safety guard rails on every assisted request | Avoid blocks/bans: budgets (100/run, 200/hour), 2–4.5 s jitter + long breaks every 8 requests, requests only while the tab is visible, and a circuit breaker → 24 h cooldown on 401/403/429, `challenge_required`, `checkpoint_required`, `feedback_required`, or non-JSON responses. Never retry on a signal. |
| 7 | Resume support instead of bigger budgets | Posts marked `collectedAt` are skipped on re-runs; a year of history is collected over several small sessions rather than one risky run. |
| 8 | Story emoji reactions are **not** collected | They arrive as DM messages; touching the DM API is the most sensitive surface. Story *likes* are collected instead (part of the viewers list). |
| 9 | Ranking math lives in the popup export, not the Next.js app (for now) | Fastest path to usable output; the app can grow an analyzer page later. |
| 10 | Bookmarklet link removed from the homepage | Obsolete and caused React warnings. |
| 11 | Followers collection is resumable (cursor + collected set persisted in `scFollowers`) | 500 followers/run cap stopped large accounts mid-way with no way to continue; now every run resumes from the saved `max_id` cursor and each export contains everything collected so far (`metadata.complete` flags a finished snapshot). A completed collection restarts fresh on the next run. |
| 12 | "Import previous export (merge)" button in popup | Exports made before resume support (or after clearing storage) can be merged back into `scFollowers`/`scEngagement`. Note: Instagram's pagination cursor cannot be reconstructed from usernames, so imported follower sets prevent data loss but pagination still re-walks from the start (cheap: 10 requests per 500). |
| 13 | Comments stored with timestamps and deduped by comment `pk` | Enables "engagement over time" analysis; pk-dedupe prevents double counting when passive + assisted capture the same comment. Likes have no timestamps in any Instagram API — use the post's `takenAt` as the time axis for likes. |
| 14 | Analysis/visualization moves to external tools (DuckDB/pandas/Gephi); the Next.js visualizer is legacy | The built-in force graph proved not useful for real analysis. Exports are plain JSON, designed to be loaded into notebooks/Gephi. |
| 15 | Follower snapshots (`scFollowerSnapshots`, last 12) for churn analysis | Each *completed* collection stores a snapshot (followers + notFollowedBack); the graph export diffs the last two snapshots → `analysis.changes.gained/lost`. Partial runs never snapshot (diff would be garbage). |
| 16 | Story view speed = first-seen timestamp approximation | Instagram exposes NO view timestamps. We record when each viewer was *first captured* (`stories.viewers[u]` = unix seconds); `avgStoryViewDelayHours` in the ranking is an upper bound on how fast they view. Accuracy depends on how often viewer lists are captured — check your story viewers several times during its 24h life. Legacy `true` values mean "time unknown". |
| 17 | Follow-back status from the followers list itself + `show_many` batches; following-list walk rejected | The followers response carries `friendship_status.following` per user (that's what renders the "Follow" button in the UI). Missing statuses are resolved via `POST /friendships/show_many/` in batches of 100 — 1 request per 100 followers instead of walking the entire following list (1 request per 50 followed accounts). Trade-off: `notFollowingMeBack` is not available (it genuinely needs the full following list; re-add if ever needed). |
| 18 | Debug mode: persistent event ring buffer (`scDebugLog`, last 300) + popup toggle/export | Console-only logging dies with the tab and is invisible for passive captures that happen while browsing. Every capture/classification/crawl request is logged as a structured event; `graphql:unmatched` and `ingest:unmatched` events reveal Instagram endpoint changes to adapt the parser to. Interceptor always traces to the page console (`[social-circle:intercept]`). |
| 19 | Viewer identity cached (`scViewer`) + passive followers capture + GraphQL timeline parsing | Debug log findings: (a) `users/{pk}/info/` is heavily rate-limited (429 broke "Collect graph" on repeated clicks) → viewer is now cached and reused from any prior state, with a 1h soft backoff on 429; (b) the posts timeline now arrives via GraphQL (`xdt_api__v1__feed__user_timeline_graphql_connection`) → parsed passively for post metadata; (c) scrolling your own followers dialog is now captured passively into `scFollowers` (incl. `friendship_status` → follow-back), guarded so other accounts' lists are ignored. |
| 20 | All legacy fork code removed; repo is extension-only | The project diverged completely from the forked visualizer (decision #14 made it legacy). Deleted: Next.js app (`pages/`, `components/`, `styles/`, `public/`, configs), bookmarklet `scripts/`, npm packaging. Only `extension/`, `context.md`, `README.md` remain. No original code survives → no attribution constraints; de-fork by pushing to a fresh GitHub repo (new remote), optionally with orphan history. |

## Architecture

```
instagram.com page (MAIN world)          extension (ISOLATED world)        popup
┌──────────────────────────┐   postMessage   ┌────────────────────┐   messages   ┌─────────────┐
│ interceptor.js           │ ──────────────► │ content.js         │ ◄──────────► │ popup.js    │
│ patches fetch/XHR,       │                 │ - ingests captures │              │ - buttons   │
│ mirrors API responses    │                 │ - assisted crawler │              │ - ranking   │
└──────────────────────────┘                 │ - chrome.storage   │              │ - export    │
                                             └────────────────────┘              └─────────────┘
```

- **Passive mode** (always on): `interceptor.js` mirrors interesting API responses →
  `content.js` parses them and merges into `chrome.storage.local`.
- **Assisted mode** (button): `content.js` crawls your own posts (last year) + live story
  viewers through `crawlFetch` (budgets, pacing, circuit breaker).
- **Export**: popup computes the ranking and downloads a single JSON.

## Data scheme

### 1. Followers graph (`<username>.json`, "Collect graph" button)

```jsonc
{
  "username": "oleg_ko3",             // you
  "metadata": {
    "loggedUserFetched": true,
    "source": "browser-extension",
    "lastRun": "2026-10-09T...",
    "complete": false,                // true when followers walked AND all statuses resolved
    "followersCollected": 500,
    "followBackUnresolved": 0         // followers whose follow-back status is still unknown
  },
  "analysis": {
    "notFollowedBack": ["user1"],     // your followers you don't follow back (null until statuses resolved)
    "changes": {                      // churn vs previous completed snapshot (null until 2 snapshots exist)
      "since": "2026-10-01T...",
      "gained": ["new_follower"],
      "lost": ["gone_follower"]
    }
  },
  "nodes": [ { "id": "username", "group": 1 } ],
  "links": [ { "source": "follower", "target": "oleg_ko3", "value": 1 } ]
}
```

### 2. Engagement store (`chrome.storage.local`, key `scEngagement`)

Internal accumulator, merged continuously by both modes:

```jsonc
{
  "viewer": { "username": "oleg_ko3", "pk": "123456" },
  "posts": {
    "<media_pk>": {
      "id": "<media_pk>",
      "takenAt": 1726000000,          // unix seconds
      "code": "DAbCdEf",              // shortcode → instagram.com/p/<code>/
      "caption": "first 120 chars…",
      "likeCount": 42,                // Instagram's own counter
      "commentCount": 7,
      "likers":     { "username": true, ... },     // who liked (set; likes have NO timestamps)
      "commenters": {
        "username": { "count": 2, "times": [1726003000, 1726004000] }  // unix seconds per comment
      },
      "commentIds": { "<comment_pk>": true },      // dedupe set (passive + assisted overlap)
      "collectedAt": "2026-10-09T..."              // set when assisted crawl finished this post
    }
  },
  "stories": {
    "<story_media_pk>": {
      "id": "<story_media_pk>",
      "takenAt": 1726000000,
      "viewers": { "username": 1726004500, ... },  // unix seconds we FIRST saw this viewer (true = legacy, time unknown)
      "likers":  { "username": true, ... }         // who liked the story (set)
    }
  },
  "updatedAt": "2026-10-09T..."
}
```

Bookkeeping keys: `scRequestLog` (timestamps for the hourly budget),
`scCooldownUntil` (circuit-breaker timestamp), `scViewer` (cached viewer identity),
`scFollowers` (resume state: cursor, `followers[u] = {pk, following: true|false|null}`,
`done` flag), `scFollowerSnapshots` (last 12 completed snapshots: followers +
notFollowedBack, for churn), `scDebug` (debug mode flag), `scDebugLog` (last 300 debug events).

### 3. Engagement export (`<username>-engagement.json`, "Export engagement" button)

Everything from the store **plus** the computed ranking:

```jsonc
{
  // ...entire scEngagement content...
  "weights": { "postLike": 1, "comment": 2, "storyView": 0.5, "storyLike": 1.5 },
  "ranking": [
    {
      "username": "best_friend",
      "postLikes": 31,        // # of your posts they liked
      "comments": 12,         // # of comments they left (all posts)
      "storyViews": 48,       // # of your stories they viewed
      "storyLikes": 9,        // # of your stories they liked
      "avgStoryViewDelayHours": 2.4,  // upper bound on how fast they view your stories (null = no timed data)
      "score": 83.5           // weighted sum, sorted descending
    }
  ],
  "exportedAt": "2026-10-09T..."
}
```

`score = 1·postLikes + 2·comments + 0.5·storyViews + 1.5·storyLikes` — comments weigh most
(highest effort), story views least (lowest effort). Tune `WEIGHTS` in `extension/popup.js`.

### Data sources per field

| Data | Endpoint (what the page itself calls) | Availability |
|---|---|---|
| Your posts + counts | `/api/v1/feed/user/{pk}/` | Full history |
| Post likers | `/api/v1/media/{id}/likers/` | Full (truncated on huge posts) |
| Post commenters | `/api/v1/media/{id}/comments/` | Full, paginated |
| Story viewers + story likes | `/api/v1/media/{id}/list_reel_media_viewer/` | **Only while the story is live (~24–48 h)** — must be captured continuously |
| Story emoji reactions | DMs | Not collected (by design) |

## How to use it for proper data collection

### One-time setup
1. `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
2. After any code change: hit ⟳ on the extension **and refresh the Instagram tab**
   (content scripts inject on page load).

### Routine — stories (most important, time-critical!)
Story viewer lists disappear ~24–48 h after posting. **While each story is live:**
1. Open instagram.com, click your own story.
2. Open the **viewers list** ("Seen by N") and **scroll it to the very bottom** —
   passive capture records every page of viewers (and likes) as Instagram loads them.
3. Alternatively press **"Collect engagement (assisted)"** in the popup while a story is
   live — it fetches all viewer pages for you.
4. Make this a habit for every story — and for **view-speed analysis, check the viewer
   list several times during the story's life** (e.g. after 1h, 6h, near expiry): each
   check timestamps newly appeared viewers, bounding how fast they viewed.

### Posts — bulk backfill (once) + passive top-ups
1. Go to any instagram.com page, open the popup → **"Collect engagement (assisted)"**.
2. Keep the Instagram tab **visible** (crawling pauses when the tab is hidden) — just
   leave it open; progress toasts appear on the page.
3. If it stops with a budget message, that's normal: run it again later (same day or
   next day) — it resumes, skipping finished posts.
4. Passive top-ups: whenever you manually open a post's **"Liked by"** dialog or scroll
   its **comments**, that data is captured too — scroll lists fully to capture all pages.
5. **Followers are captured passively too**: open your own profile → Followers dialog and
   scroll it — every page (including follow-back status) merges into the same resumable
   state that "Collect graph" uses. Other accounts' follower lists are ignored.

### Export & analyze
1. Popup → **"Export engagement + ranking"** → saves `<username>-engagement.json`.
2. The `ranking` array is your answer to "who likes me most"; raw `posts`/`stories` allow
   custom analysis (e.g. normalize by how long someone has followed you).
3. Popup → **"Collect graph"** exports the followers graph plus `analysis`:
   - `notFollowedBack` — derived from per-follower `friendship_status` in the list itself,
     topped up by cheap `show_many` batches; valid once `followBackUnresolved` is 0.
   - `changes.gained` / `changes.lost` — follower churn vs the previous **completed** run;
     appears from the second completed collection onward. Run a complete collection
     periodically (e.g. weekly) to build the snapshot history.
   Each run collects up to 500 followers and saves its cursor: if the export says
   `"complete": false`, run again later — it resumes. After a complete snapshot, the next
   run starts fresh.
4. Popup → **"Import previous export (merge)"** → feed an older `<username>.json` or
   `<username>-engagement.json` back into storage (e.g. after clearing storage or for
   exports made before resume support). Merging never overwrites newer data.

### Time axis for "interests over time" analysis
- Posts and stories carry `takenAt` (unix seconds) = content creation time.
- Comments carry per-comment timestamps (`commenters[u].times`).
- Likes and story views have **no timestamps in Instagram's API** — attribute them to the
  content's `takenAt` (engagement on a post clusters within days of posting, so this is a
  good approximation).

### If Instagram pushes back
- A toast saying crawling is **paused for ~24 h** means the circuit breaker tripped.
  Do nothing; don't retry. Passive capture keeps working — browse normally.
- Collected data is never lost; everything merges incrementally in `chrome.storage`.

## Debugging data collection

1. **Enable debug mode**: popup → Debug → check "Debug mode". Every capture, parse
   decision and crawl request becomes a structured event in a ring buffer (last 300).
2. **Live view**: open DevTools on the Instagram tab → Console → filter `social-circle`:
   - `[social-circle:intercept] <url>` — the MAIN-world patch saw a matching response
     (always on, even without debug mode).
   - `[social-circle] ingest:*` — how each capture was classified and how many
     users/comments were extracted (debug mode only).
   - `[social-circle] crawl:request` — every assisted request with HTTP status and
     run counter.
3. **Event taxonomy**: `ingest:story-viewers|post-likers|post-comments|feed-posts|reels-media`,
   `ingest:graphql-*` (passive GraphQL hits), `ingest:non-json`, `ingest:unmatched` and
   `graphql:unmatched`/`graphql:no-media-id` (endpoint changed — the logged `keys` show
   what to adapt the parser to), `safety:fuse-tripped`.
4. **Offline analysis**: popup → "Export debug log" → `social-circle-debug.json`.
   The Debug section also shows the hourly request budget usage and active cooldown.
5. **Inspect raw storage**: DevTools on the Instagram tab → Console → switch the context
   dropdown (top-left, says "top") to **Social Circle Collector** → run
   `chrome.storage.local.get(console.log)`.
6. **Popup logic**: right-click the popup → Inspect (it has its own console).
7. **Typical failure signatures**:
   - intercept lines appear but no `ingest:*` → parser doesn't recognize the shape; check
     `ingest:unmatched`/`graphql:unmatched` events for the new keys.
   - no intercept lines at all → interceptor not injected: reload extension AND refresh
     the tab; check `chrome://extensions` for errors.
   - `crawl:request` with status 4xx → safety fuse handles it; check `safety:fuse-tripped`.

## Known limitations
- Story history is forward-only: stories that expired before collection are gone forever.
- Story emoji reactions (DMs) are out of scope.
- `likers` on posts with thousands of likes may be truncated by Instagram.
- Clearing browser extension storage (or "Clear engagement data") deletes the accumulator —
  export regularly.
