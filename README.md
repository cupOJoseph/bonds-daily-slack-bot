# Bond Buyer Daily Bot

Reads the Bond Buyer and posts updates to Slack daily, after finding the most
interesting or important topics with AI. Runs weekdays at 8:00 AM Eastern.

## How it works

1. A GitHub Actions cron job runs each weekday morning (two UTC slots cover
   daylight saving; the script only proceeds in the slot that is 8am ET).
2. [src/digest.mjs](src/digest.mjs) pulls `bondbuyer.com/feed?rss=true`, keeps
   articles from the last 24 hours (72 on Mondays to cover the weekend), and
   fetches each article's full text.
3. Claude (`claude-sonnet-5`) picks the 3–5 most important stories and writes
   summaries with a "why it matters" line for the team.
4. The digest is posted to Slack via an incoming webhook, with links back to
   each article.

## Setup

1. **Slack webhook**: create a Slack app at <https://api.slack.com/apps> →
   *Create New App* → *From scratch*. Under **Incoming Webhooks**, toggle it on,
   click *Add New Webhook to Workspace*, and pick the target channel. Copy the
   webhook URL.
2. **GitHub repo**: push this directory to a (private) GitHub repo.
3. **Secrets**: in the repo → Settings → Secrets and variables → Actions, add:
   - `ANTHROPIC_API_KEY`
   - `SLACK_WEBHOOK_URL`
4. Test it: Actions tab → *Bond Buyer daily digest* → *Run workflow* (check
   *dry run* first if you want to see the payload in the logs without posting).

## Local testing

```bash
cp .env.example .env   # fill in keys; keep DRY_RUN=1 to print instead of post
npm install
npm run digest:local
```

Env knobs: `DRY_RUN=1` prints the Slack payload; `LOOKBACK_HOURS=48` widens the
article window (useful for testing on a quiet day).

## Notes

- **GitHub's cron is best-effort and has been observed firing hours late.**
  The job therefore never checks the clock; instead a per-Eastern-day cache
  lock (`digest-posted-<date>`) guarantees exactly one digest per weekday, so
  both cron slots and any delayed firing race safely. The lock is only taken
  after a successful real post, so a failure leaves the day open for retry.
  The Slack header shows the actual send time, not a hardcoded 8:00.
- The digest posts a one-line "no new articles" note rather than staying
  silent, so a broken run is distinguishable from a quiet news day.
- Article text is extracted from the page's `RichTextArticleBody` container;
  if Bond Buyer changes their markup, the bot falls back to RSS teasers and
  logs a warning (the digest still posts, just with less depth).
