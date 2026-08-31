// Vercel cron entry point for the Bond Buyer digest.
//
// vercel.json fires two UTC crons (12:07 and 13:07) so that one of them is
// always 8:07 AM Eastern regardless of DST; the other is 7:07 or 9:07 ET and
// exits here. Vercel Pro invokes crons within the scheduled minute, so this
// hour check has ~53 minutes of slack -- unlike GitHub's best-effort cron,
// which is why this moved off Actions.
//
// Env: ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL, CRON_SECRET

import { runDigest, easternNow, DIGEST_HOUR_ET } from "../src/digest.mjs";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const eastern = easternNow();
  const url = new URL(req.url, "http://localhost");
  const dryRun = url.searchParams.get("dry") === "1";
  // ?force=1 runs outside the morning window, for manual checks.
  const force = url.searchParams.get("force") === "1" || dryRun;

  if (!force && eastern.hour !== DIGEST_HOUR_ET) {
    console.log(`${eastern.timeLabel} is not the ${DIGEST_HOUR_ET}am ET slot; skipping.`);
    return res.status(200).json({ skipped: true, reason: "off-slot", at: eastern.timeLabel });
  }

  try {
    const result = await runDigest({
      dryRun,
      lookbackHours: url.searchParams.get("lookback"),
    });
    return res.status(200).json({ ok: true, at: eastern.timeLabel, ...result, payload: undefined });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
