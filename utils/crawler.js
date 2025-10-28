import { chromium } from "playwright";
import { isAllowedToCrawl } from "./robot.js";
import { upsertJob, batchUpsert } from "../models/jobs.models.js";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_USER_AGENT =
  process.env.CRAWL_USER_AGENT || "JobHunterBot/1.0 (+you@example.com)";
const DEFAULT_MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "2", 10);
const DESCRIPTION_MAX_CHARS = 1000;
const PREVIEW_CHARS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sanitizeText(s) {
  return s ? String(s).replace(/\s+/g, " ").trim() : "";
}
function uniqueByJobId(items) {
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (!it || !it.jobId) continue;
    if (seen.has(it.jobId)) continue;
    seen.add(it.jobId);
    uniq.push(it);
  }
  return uniq;
}

async function extractDescriptionText(page) {
  try {
    const selectorList = [
      ".listing-container",
      ".listing-body",
      ".content",
      "article",
      "main",
    ];
    const descriptionText = await page
      .$$eval(selectorList.join(","), (nodes) => {
        const node = nodes.find(
          (n) =>
            n &&
            (n.innerText || n.textContent) &&
            (n.innerText || n.textContent).trim().length > 0
        );
        return node ? node.innerText || node.textContent : "";
      })
      .catch(() => "");

    if (!descriptionText) return "";

    let text = descriptionText.replace(/\s+/g, " ").trim();
    text = text
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    if (text.length > DESCRIPTION_MAX_CHARS) {
      return text.slice(0, DESCRIPTION_MAX_CHARS) + "...";
    }
    return text;
  } catch (err) {
    console.warn("[extractDescriptionText] failed:", err && err.message ? err.message : err);
    return "";
  }
}

async function parseJobDetail(page, url) {
  try {
    console.log("[parseJobDetail] navigating to:", url);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!response) {
      console.warn("[parseJobDetail] no response for", url);
      return null;
    }
    if (response.status() >= 400) {
      console.warn(`[parseJobDetail] HTTP ${response.status()} for ${url}`);
    }

    const hasDetail = await page.$(
      ".listing-container, .listing-body, .content, article, main"
    );
    if (!hasDetail) {
      console.warn("[parseJobDetail] page does not look like a job detail, skipping:", url);
      return null;
    }

    await page.waitForTimeout(700 + Math.random() * 600);

    const title = await page
      .$$eval("h1, .listing-header h1, .job-title", (nodes) => {
        const n = nodes[0];
        return n ? n.textContent.trim() : "";
      })
      .catch(() => "");

    let company = "";
    try {
      company = await page.$eval(
        ".company, .company a, .listing-header .company",
        (el) => el.textContent.trim()
      );
    } catch (e) {
      company = "";
    }

    let location = "";
    try {
      location = await page.$eval(
        ".region, .location, .listing-header .location",
        (el) => el.textContent.trim()
      );
    } catch (e) {
      location = "";
    }
    if (!location && /remote/i.test(title + " " + company)) location = "Remote";

    const descriptionText = await extractDescriptionText(page);
    const descriptionPreview = descriptionText
      ? descriptionText.slice(0, PREVIEW_CHARS) +
        (descriptionText.length > PREVIEW_CHARS ? "..." : "")
      : "";

    const parts = url.split("/").filter(Boolean);
    const rawId = parts[parts.length - 1] || url;

    const job = {
      jobId: `weworkremotely-${rawId}`,
      title: sanitizeText(title),
      company: sanitizeText(company),
      location: sanitizeText(location || "Remote"),
      postedAt: new Date().toISOString(),
      description: descriptionText,
      descriptionPreview,
      applyUrl: url,
      source: "weworkremotely",
      remoteOk: /remote/i.test((location || "") + " " + (title || "")),
    };

    console.log("[parseJobDetail] parsed job:", job.jobId, job.title || "(no title)");
    return job;
  } catch (err) {
    console.error("[parseJobDetail] error parsing", url, err && err.stack ? err.stack : err);
    return null;
  }
}

async function collectJobLinksFromListing(page, listingUrl) {
  try {
    console.log("[collectJobLinks] goto listing:", listingUrl);
    await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(900);

    const rawLinks = await page.$$eval("a[href]", (anchors) =>
      anchors.map((a) => (a.href || "").trim()).filter(Boolean)
    );

    const links = Array.from(new Set(rawLinks)).filter((h) => {
      try {
        const u = new URL(h, "https://weworkremotely.com");
        if (!u.pathname.includes("/remote-jobs/")) return false;
        if (u.search || u.hash) return false;
        if (
          u.pathname.includes("/new") ||
          u.pathname.includes("/all-jobs") ||
          u.pathname.includes("/search")
        )
          return false;
        const parts = u.pathname.split("/").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        if (!last.includes("-")) return false;
        return true;
      } catch (e) {
        return false;
      }
    });

    console.log(`[collectJobLinks] discovered ${links.length} candidate job links`);
    return links;
  } catch (err) {
    console.error("[collectJobLinks] error collecting links from", listingUrl, err && err.stack ? err.stack : err);
    return [];
  }
}

export async function crawlWeWorkRemotely({
  startUrl = "https://weworkremotely.com/remote-jobs/search?term=node",
  maxPages = DEFAULT_MAX_PAGES,
} = {}) {
  console.log("[crawlWeWorkRemotely] starting", { startUrl, maxPages });

  const base = "https://weworkremotely.com";
  try {
    const ok = await isAllowedToCrawl(base, DEFAULT_USER_AGENT);
    if (!ok) {
      console.warn("[crawlWeWorkRemotely] robots.txt suggests no crawl; aborting.");
      throw new Error("Crawling disallowed by robots.txt");
    }
  } catch (err) {
    console.warn("[crawlWeWorkRemotely] robots check failed or disallowed:", err && err.message ? err.message : err);
  }

  const headless = process.env.CRAWL_HEADLESS === "false" ? false : true;
  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({ headless, args: ["--no-sandbox"] });
    context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT, locale: "en-US" });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    let pageIndex = 0;
    const buffer = [];
    const seenUrls = new Set();

    while (pageIndex < maxPages) {
      const listingUrl = pageIndex === 0 ? startUrl : `${startUrl}&page=${pageIndex + 1}`;
      console.log(`[crawl] fetching listing page ${pageIndex + 1}: ${listingUrl}`);

      const links = await collectJobLinksFromListing(page, listingUrl);
      console.log(`[crawl] links found: ${links.length} (page ${pageIndex + 1})`);

      if (!links.length) {
        console.warn("[crawl] no links found on this listing page — stopping pagination.");
        break;
      }

      for (const link of links) {
        try {
          if (seenUrls.has(link)) {
            console.log("[crawl] skipping seen link:", link);
            continue;
          }
          seenUrls.add(link);
          const job = await parseJobDetail(page, link);
          if (job) buffer.push(job);
          else console.warn("[crawl] parse returned null for", link);
        } catch (err) {
          console.error("[crawl] error parsing job", link, err && err.stack ? err.stack : err);
        }

        if (buffer.length >= 20) {
          const chunk = buffer.splice(0, 20);
          const uniqueChunk = uniqueByJobId(chunk);
          if (uniqueChunk.length > 0) {
            try {
              console.log(`[crawl] batchUpsert ${uniqueChunk.length} unique jobs to DynamoDB...`);
              await batchUpsert(uniqueChunk);
              console.log("[crawl] batchUpsert success");
            } catch (err) {
              console.error("[crawl] batchUpsert failed", err && err.stack ? err.stack : err);
              buffer.unshift(...uniqueChunk);
              await sleep(2000);
            }
          } else {
            console.log("[crawl] chunk had no unique items, skipping batchUpsert");
          }
        }

        await sleep(700 + Math.random() * 800);
      }

      pageIndex++;
      await sleep(1500 + Math.random() * 1500);
    }

    if (buffer.length) {
      const finalChunk = buffer.splice(0);
      const uniqueFinal = uniqueByJobId(finalChunk);
      if (uniqueFinal.length > 0) {
        try {
          console.log(`[crawl] final batchUpsert of ${uniqueFinal.length} unique jobs...`);
          await batchUpsert(uniqueFinal);
          console.log("[crawl] final flush success");
        } catch (err) {
          console.error("[crawl] final batchUpsert failed", err && err.stack ? err.stack : err);
        }
      } else {
        console.log("[crawl] nothing unique to flush at the end");
      }
    }

    console.log("[crawl] finished successfully");
  } catch (err) {
    console.error("[crawlWeWorkRemotely] top-level error:", err && err.stack ? err.stack : err);
    throw err;
  } finally {
    try { if (context) await context.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
  }
}
