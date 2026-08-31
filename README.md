# Bond Buyer Daily Bot

Reads the Bond Buyer and posts updates to Slack daily, after finding the most
interesting or important topics with AI. Runs weekdays at 8:00 AM Eastern.

## How it works

1. **Vercel Cron** hits `/api/digest` on the production deployment at 12:07 and
   13:07 UTC, Mon-Fri. Whichever one is 8:07 AM Eastern proceeds; the other
   (7:07 or 9:07 ET, depending on DST) exits immediately. Vercel Pro fires
   crons within the scheduled minute, so that hour check has ~53 min of slack.
2. [src/digest.mjs](src/digest.mjs) pulls `bondbuyer.com/feed?rss=true`, keeps
   articles from the last 24 hours (72 on Mondays to cover the weekend), and
   fetches each article's full text.
3. Claude (`claude-sonnet-5`) picks the 3-5 most important stories and writes
   short summaries with a "why it matters" line for the team.
4. The digest is posted to Slack via an incoming webhook, with links back to
   each article.

## Setup

**Vercel** (the scheduler): import this repo as a Vercel project, framework
preset "Other", no build command. Add three Production environment variables:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `SLACK_WEBHOOK_URL` | Slack app -> Incoming Webhooks |
| `CRON_SECRET` | any random 16+ char string; Vercel sends it as `Authorization: Bearer ...` |

Deploy to production -- crons only run against the production deployment, and
only after a deploy that includes `vercel.json`.

**Manual/dry runs** against the deployment:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<project>.vercel.app/api/digest?dry=1"
```

`?dry=1` builds the digest and returns it without posting (and bypasses the
hour check). `?force=1` posts outside the morning window. `?lookback=48`
widens the article window.

The GitHub Actions workflow is manual-only now (no `schedule:`), kept as a
fallback path that cannot double-post alongside Vercel. It still needs the
`ANTHROPIC_API_KEY` / `SLACK_WEBHOOK_URL` secrets in the `prod` environment.

## Local testing

```bash
cp .env.example .env   # fill in keys; keep DRY_RUN=1 to print instead of post
npm install
npm run digest:local
```

Env knobs: `DRY_RUN=1` prints the Slack payload; `LOOKBACK_HOURS=48` widens the
article window (useful for testing on a quiet day).

## Notes

- Scheduling moved from GitHub Actions to Vercel Cron: GitHub delivered this
  job ~10 hours late (6:12 PM ET) or skipped the day entirely, while Vercel Pro
  guarantees per-minute precision. The Slack header shows the actual send time.
- Vercel cron delivery is best effort and can, rarely, invoke the same schedule
  twice; there is no cross-invocation lock, so a duplicate post is possible. If
  that ever happens, the fix is a Redis/KV lock keyed on the Eastern date.
- The digest posts a one-line "no new articles" note rather than staying
  silent, so a broken run is distinguishable from a quiet news day.
- Article text is extracted from the page's `RichTextArticleBody` container;
  if Bond Buyer changes their markup, the bot falls back to RSS teasers and
  logs a warning (the digest still posts, just with less depth).
