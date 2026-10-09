# Social Circle Collector

A local Chrome extension (Manifest V3) that collects your own Instagram social data —
followers, post likes/comments, story viewers — and exports it as JSON for analysis in
external tools (pandas/DuckDB/Gephi).

No servers, no third-party scripts: everything runs in your own browser session, with
conservative pacing and an automatic circuit breaker to protect your account.

## Install

1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Sign in to instagram.com.

## Use

- **Collect graph** — resumable followers collection (+ follow-back analysis, churn vs
  previous runs). Exports `<username>.json`.
- **Collect engagement (assisted)** — slowly crawls your posts from the last year and
  live story viewers. Progress is saved; re-run to resume.
- **Passive capture (always on)** — browsing your own followers list, story viewers,
  post likers and comments records everything automatically with zero extra requests.
- **Export engagement + ranking** — exports `<username>-engagement.json` including a
  per-follower engagement score.

Full documentation — architecture, data schema, collection routine, debugging — lives in
[context.md](context.md).

