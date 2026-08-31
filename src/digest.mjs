// Bond Buyer daily digest → Slack.
//
// Pulls the Bond Buyer RSS feed, fetches full article text for everything
// published since the last weekday-morning run, asks Claude to pick and
// summarize the most important stories, and posts the digest to Slack.
//
// Env:
//   ANTHROPIC_API_KEY   required (resolved automatically by the SDK)
//   SLACK_WEBHOOK_URL   required unless DRY_RUN=1
//   DRY_RUN=1           print the Slack payload instead of posting
//   LOOKBACK_HOURS=n    override the article window (default 24, Monday 72)

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.bondbuyer.com/feed?rss=true";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_ARTICLES = 15;
const MAX_ARTICLE_CHARS = 9000;

// ---------- time helpers (everything anchored to America/New_York) ----------

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get("hour")) % 24;
  const minute = get("minute");
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return {
    weekday: get("weekday"),
    hour,
    dateLabel: `${get("weekday")}, ${get("month")} ${get("day")}, ${get("year")}`,
    timeLabel: `${hour12}:${minute} ${hour < 12 ? "AM" : "PM"} ET`,
  };
}

// ---------- feed + article fetching ----------

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: true });
  const doc = parser.parse(xml);
  let items = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return items.map((item) => ({
    title: String(item.title ?? "").trim(),
    link: String(item.link ?? "").trim(),
    description: String(item.description ?? "").trim(),
    pubDate: new Date(item.pubDate ?? 0),
    author: String(item["dc:creator"] ?? "").trim(),
    categories: [item.category ?? []].flat().map(String),
  }));
}

function htmlToPlainText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// The article body sits in a RichTextArticleBody-body div and ends at the
// reprint/licensing footer. Fall back to the RSS description if the page
// layout ever changes.
export function extractArticleBody(html) {
  const marker = html.indexOf("RichTextArticleBody-body");
  if (marker === -1) return null;
  const start = html.indexOf(">", marker) + 1;
  let end = html.indexOf("For reprint and licensing", start);
  if (end === -1) end = start + 60000;
  const text = htmlToPlainText(html.slice(start, end));
  return text.length > 200 ? text.slice(0, MAX_ARTICLE_CHARS) : null;
}

// ---------- summarization ----------

const DigestSchema = z.object({
  overview: z
    .string()
    .describe(
      "One sentence, 30 words max, capturing the day's overall theme for the municipal bond market."
    ),
  picks: z
    .array(
      z.object({
        title: z.string().describe("The article's headline, verbatim"),
        url: z.string().describe("The article's URL, verbatim"),
        summary: z
          .string()
          .describe(
            "One or two tight sentences, 35 words max. Lead with the concrete fact " +
            "(who, what, how much). No preamble, no restating the headline."
          ),
        whyItMatters: z
          .string()
          .describe(
            "A single short clause, 15 words max, on why it matters to a municipal " +
            "finance startup. Omit if it would just restate the summary."
          ),
      })
    )
    .min(1)
    .max(5)
    .describe("The 3-5 most important or interesting articles, most important first"),
  alsoNotable: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .max(6)
    .describe("Remaining articles worth a glance, if any"),
});

async function summarize(articles, dateLabel) {
  const client = new Anthropic();
  const corpus = articles
    .map(
      (a, i) =>
        `<article index="${i + 1}">\n` +
        `Title: ${a.title}\nURL: ${a.link}\nAuthor: ${a.author}\n` +
        `Published: ${a.pubDate.toISOString()}\nTags: ${a.categories.join(", ")}\n\n` +
        `${a.body ?? a.description}\n</article>`
    )
    .join("\n\n");

  const response = await client.beta.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system:
      "You write a morning briefing on The Bond Buyer for the team at Open Charter, " +
      "a startup working in municipal finance. The team knows the muni market well; " +
      "skip background explainers and get to what happened and what it means. " +
      "Prioritize market-moving news: rating actions, notable deals, regulatory and " +
      "policy changes, market structure shifts, and major issuer credit stories. " +
      "Deprioritize personnel announcements, obituaries, and event promos unless truly " +
      "significant. Use only the provided articles; never invent facts or URLs. " +
      "Be concise above all: this is a scannable brief, not an article. Short " +
      "declarative sentences, concrete numbers, no filler like \"the article " +
      "discusses\" or \"this development highlights\".",
    messages: [
      {
        role: "user",
        content:
          `Here are The Bond Buyer's articles for the ${dateLabel} morning briefing:\n\n` +
          `${corpus}\n\nSelect and summarize the most important stories for the digest.`,
      },
    ],
    output_format: betaZodOutputFormat(DigestSchema),
  });

  if (!response.parsed_output) {
    throw new Error(`Digest parsing failed (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

// ---------- Slack ----------

function mrkdwnEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackLink(url, label) {
  return `<${url}|${mrkdwnEscape(label).replace(/\|/g, "-")}>`;
}

export function buildSlackPayload(digest, dateLabel, timeLabel = "") {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "The Bond Buyer — Daily Brief", emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${dateLabel} · Posted ${timeLabel}` }],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Overview of the day*\n${mrkdwnEscape(digest.overview)}`,
      },
    },
    { type: "divider" },
    ...digest.picks.map((pick) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${slackLink(pick.url, pick.title)}*\n` +
          `${mrkdwnEscape(pick.summary)}\n_${mrkdwnEscape(pick.whyItMatters)}_`,
      },
    })),
  ];

  if (digest.alsoNotable.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "*Also notable:* " +
            digest.alsoNotable.map((a) => slackLink(a.url, a.title)).join(" · "),
        },
      ],
    });
  }

  return { text: `The Bond Buyer — Daily Brief, ${dateLabel}`, blocks };
}

async function postToSlack(payload) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

// ---------- main ----------

async function main() {
  const now = new Date();
  const eastern = easternParts(now);

  const defaultLookback = eastern.weekday === "Mon" ? 72 : 24;
  const lookbackHours = Number(process.env.LOOKBACK_HOURS) || defaultLookback;
  const cutoff = new Date(now.getTime() - lookbackHours * 3600 * 1000);

  console.log(`Fetching feed (articles since ${cutoff.toISOString()})...`);
  const feedItems = parseFeed(await fetchText(FEED_URL));
  const fresh = feedItems
    .filter((item) => item.link && item.pubDate > cutoff)
    .slice(0, MAX_ARTICLES);
  console.log(`${feedItems.length} items in feed, ${fresh.length} within window.`);

  if (fresh.length === 0) {
    const payload = {
      text: `The Bond Buyer — no new articles in the last ${lookbackHours} hours.`,
    };
    if (process.env.DRY_RUN === "1") console.log(JSON.stringify(payload, null, 2));
    else await postToSlack(payload);
    return;
  }

  const articles = await Promise.all(
    fresh.map(async (item) => {
      try {
        const body = extractArticleBody(await fetchText(item.link));
        if (!body) console.warn(`Body extraction failed for ${item.link}; using RSS summary.`);
        return { ...item, body };
      } catch (err) {
        console.warn(`Fetch failed for ${item.link} (${err.message}); using RSS summary.`);
        return { ...item, body: null };
      }
    })
  );

  console.log("Summarizing with Claude...");
  const digest = await summarize(articles, eastern.dateLabel);
  const payload = buildSlackPayload(digest, eastern.dateLabel, eastern.timeLabel);

  if (process.env.DRY_RUN === "1") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  await postToSlack(payload);
  console.log(`Posted digest with ${digest.picks.length} picks to Slack.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
