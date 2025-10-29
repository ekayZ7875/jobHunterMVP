import { chromium } from "playwright";
import { isAllowedToCrawl } from "./robot.js";
import { upsertJob, batchUpsert, scanJobs } from "../models/jobs.models.js";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_USER_AGENT =
  process.env.CRAWL_USER_AGENT || "JobHunterBot/1.0 (+you1@example.com)";
const DEFAULT_MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "5", 10);
const DEFAULT_MAX_NO_NEW = parseInt(process.env.CRAWL_MAX_NO_NEW_PAGES || "5", 10);
const DESCRIPTION_MAX_CHARS = 1000;
const PREVIEW_CHARS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sanitizeText(s) {
  return s ? String(s).replace(/\s+/g, " ").trim() : "";
}

// Helper: remove duplicate items by jobId
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

/**
 * Load all existing jobIds from Dynamo into a Set.
 * Uses scanJobs pagination; safe for small/medium tables.
 */
async function loadExistingJobIds() {
  const seen = new Set();
  let lastKey = undefined;
  const pageLimit = 500;
  console.log("[loadExistingJobIds] scanning existing jobs in Dynamo...");
  while (true) {
    const { items, lastEvaluatedKey } = await scanJobs({
      limit: pageLimit,
      exclusiveStartKey: lastKey,
    });
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it && it.jobId) seen.add(it.jobId);
      }
    }
    if (!lastEvaluatedKey) break;
    lastKey = lastEvaluatedKey;
  }
  console.log(`[loadExistingJobIds] found ${seen.size} existing jobs`);
  return seen;
}

// Extract text-only description, normalize and truncate
async function extractDescriptionText(page) {
  try {
    const selectorList = [
      ".listing-container",
      ".listing-body",
      ".content",
      "article",
      "main",
      ".job-listing",
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
    console.warn(
      "[extractDescriptionText] failed:",
      err && err.message ? err.message : err
    );
    return "";
  }
}

// retry helper with exponential backoff
async function retryWithBackoff(fn, { attempts = 3, baseDelay = 600 } = {}) {
  let i = 0;
  while (i < attempts) {
    try {
      return await fn();
    } catch (err) {
      i++;
      if (i >= attempts) throw err;
      const delay = baseDelay * Math.pow(2, i - 1);
      console.warn(
        `[retryWithBackoff] attempt ${i} failed, retrying in ${delay}ms — ${err && err.message ? err.message : err}`
      );
      await sleep(delay);
    }
  }
}

// Robust company extraction with several fallbacks
async function extractCompanyName(page) {
  const selectors = [
    ".company",
    ".company a",
    ".listing-header .company",
    ".lis-container__job__sidebar__companyDetails__info__title h3",
    ".lis-container__header__hero__company-info h2",
    ".lis-container__header__hero__company-info__title",
    ".listing-header .company-name",
    ".new-listing__company-name",
    'a[href^="/company/"]',
  ];

  for (const sel of selectors) {
    try {
      const v = await page.$eval(
        sel,
        (el) => {
          const clone = el.cloneNode(true);
          // remove noisy children
          clone.querySelectorAll("img, svg, i, button, .icon, .apply-btn, .listing-apply-cta").forEach((n) => n.remove());
          return (clone.textContent || "").trim();
        }
      ).catch(() => null);

      if (v && v.length > 0) {
        const cleaned = v.replace(/(View company|Save job|Apply now|→|›)/gi, "").replace(/\s+/g, " ").trim();
        if (cleaned) return cleaned;
      }
    } catch (e) {
      // ignore and try next
    }
  }

  // fallback: extract slug from company link
  try {
    const href = await page.$eval('a[href^="/company/"]', (a) => a.getAttribute("href")).catch(() => null);
    if (href) {
      const parts = href.split("/").filter(Boolean);
      const idx = parts.indexOf("company");
      if (idx >= 0 && parts[idx + 1]) {
        const slug = parts[idx + 1].replace(/[-_]/g, " ");
        const name = slug
          .split(" ")
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
          .join(" ")
          .trim();
        if (name) return name;
      }
    }
  } catch (e) {
    // ignore
  }

  // last small heuristic
  try {
    const maybe = await page.$$eval(".listing-header, .lis-container__header__hero__company-info", (nodes) => {
      for (const n of nodes) {
        const a = n.querySelector("a");
        if (a && a.textContent && a.textContent.trim().length > 1) return a.textContent.trim();
      }
      return "";
    }).catch(() => "");
    if (maybe) return maybe;
  } catch (e) {}

  return "";
}

async function parseJobDetail(page, url) {
  return retryWithBackoff(async () => {
    try {
      console.log("[parseJobDetail] navigating to:", url);

      // increased nav timeout via env
      const navTimeout = parseInt(process.env.CRAWL_NAV_TIMEOUT_MS || "60000", 10);
      page.setDefaultNavigationTimeout(navTimeout);
      page.setDefaultTimeout(navTimeout);

      // ensure page routing is not set earlier - we assume route set in crawl once,
      // but in case it's not, try to set it (wrapped)
      try {
        // If route already set Playwright will throw; we ignore that
        await page.route("**/*", (route) => {
          try {
            const req = route.request();
            const type = req.resourceType();
            // block heavy/optional resources
            if (["image", "media", "font", "stylesheet", "manifest"].includes(type)) {
              return route.abort();
            }
            return route.continue();
          } catch (e) {
            try { route.continue(); } catch (e2) {}
          }
        });
      } catch (e) {
        // ignore
      }

      // Navigate - try domcontentloaded first, then fallbacks
      let response = null;
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
      } catch (e) {
        console.warn("[parseJobDetail] goto domcontentloaded failed, trying load:", e && e.message ? e.message : e);
        try {
          response = await page.goto(url, { waitUntil: "load", timeout: navTimeout });
        } catch (e2) {
          console.warn("[parseJobDetail] goto load failed, trying networkidle:", e2 && e2.message ? e2.message : e2);
          response = await page.goto(url, { waitUntil: "networkidle", timeout: navTimeout });
        }
      }

      if (!response) {
        console.warn("[parseJobDetail] no response for", url);
        // continue to try selecting content
      } else if (response.status && response.status() >= 400) {
        console.warn(`[parseJobDetail] HTTP ${response.status()} for ${url}`);
      }

      // give small delay for content to render
      await page.waitForTimeout(500 + Math.random() * 800);

      // check for presence of expected detail selectors
      const detailSelectors = [".listing-container", ".listing-body", ".content", "article", "main", ".job-listing"];
      let hasDetail = null;
      for (const sel of detailSelectors) {
        hasDetail = await page.$(sel);
        if (hasDetail) break;
      }

      if (!hasDetail) {
        try {
          await page.waitForSelector("h1, .listing-header h1, .job-title", { timeout: 3000 });
          hasDetail = true;
        } catch (e) {
          console.warn("[parseJobDetail] page does not look like a job detail after retries:", url);
          throw new Error("No job detail selectors found");
        }
      }

      // extract title
      const title = (await page.$$eval("h1, .listing-header h1, .job-title", (nodes) => {
        const n = nodes[0];
        return n ? n.textContent.trim() : "";
      }).catch(() => "")) || "";

      // extract company via helper
      let company = "";
      try {
        company = await extractCompanyName(page);
      } catch (e) {
        company = "";
      }

      // extract location
      let location = "";
      try {
        location = await page.$eval(".region, .location, .listing-header .location", (el) => (el && el.textContent ? el.textContent.trim() : "")).catch(() => "");
      } catch (e) {
        location = "";
      }
      if (!location && /remote/i.test(title + " " + company)) location = "Remote";

      const descriptionText = await extractDescriptionText(page);
      const descriptionPreview = descriptionText
        ? descriptionText.slice(0, PREVIEW_CHARS) + (descriptionText.length > PREVIEW_CHARS ? "..." : "")
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
      console.warn("[parseJobDetail] navigation/parsing error for", url, err && err.message ? err.message : err);
      // rethrow to trigger retryWithBackoff
      throw err;
    }
  }, { attempts: 3, baseDelay: 800 });
}

async function collectJobLinksFromListing(page, listingUrl) {
  try {
    console.log("[collectJobLinks] goto listing:", listingUrl);
    const res = await page.goto(listingUrl, {
      waitUntil: "domcontentloaded",
      timeout: parseInt(process.env.CRAWL_NAV_TIMEOUT_MS || "60000", 10),
    });
    if (!res) console.warn("[collectJobLinks] no response for listing:", listingUrl);
    await page.waitForTimeout(900);

    const rawLinks = await page.$$eval("a[href]", (anchors) =>
      anchors.map((a) => (a.href || "").trim()).filter(Boolean)
    );

    const links = Array.from(new Set(rawLinks)).filter((h) => {
      try {
        const u = new URL(h, "https://weworkremotely.com");
        // allow remote-jobs listing and some listing variants, reject obvious non-job anchors
        if (!u.pathname.includes("/remote-jobs/")) return false;
        if (u.pathname.includes("/new") || u.pathname.includes("/all-jobs")) return false;
        // allow queryless job detail paths (no search/hash)
        if (u.search || u.hash) return false;
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

/**
 * Public crawler function with duplicate protections and full-run mode
 */
export async function crawlWeWorkRemotely({
  startUrl = "https://weworkremotely.com/remote-jobs",
  maxPages = DEFAULT_MAX_PAGES,
  maxConsecutiveNoNew = DEFAULT_MAX_NO_NEW,
} = {}) {
  console.log("[crawlWeWorkRemotely] starting (full-run mode)", {
    startUrl,
    maxPages,
    maxConsecutiveNoNew,
  });

  const base = "https://weworkremotely.com";
  try {
    const ok = await isAllowedToCrawl(base, DEFAULT_USER_AGENT);
    if (!ok) {
      console.warn("[crawlWeWorkRemotely] robots.txt suggests no crawl; aborting.");
      throw new Error("Crawling disallowed by robots.txt");
    }
  } catch (err) {
    console.warn("[crawlWeWorkRemotely] robots check failed or disallowed:", err && err.message ? err.message : err);
    // optional: throw err;
  }

  // Load existing jobIds once (persistence across runs)
  const existingJobIds = await loadExistingJobIds();

  const headless = process.env.CRAWL_HEADLESS === "false" ? false : true;
  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({ headless, args: ["--no-sandbox"] });
    context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    // Set resource blocking once per page/context to speed loads and reduce timeouts
    try {
      await page.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (["image", "media", "font", "stylesheet", "manifest"].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
    } catch (e) {
      // ignore if route already exists or Playwright throws
    }

    let pageIndex = 0;
    const buffer = [];
    const seenUrls = new Set(); // seen within this run (URLs)
    let consecutiveNoNew = 0;

    while (pageIndex < maxPages) {
      const listingUrl =
        pageIndex === 0 ? startUrl : `${startUrl}&page=${pageIndex + 1}`;
      console.log(`[crawl] fetching listing page ${pageIndex + 1}: ${listingUrl}`);

      const links = await collectJobLinksFromListing(page, listingUrl);
      console.log(`[crawl] links found on page ${pageIndex + 1}: ${links.length}`);

      if (!links.length) {
        console.warn("[crawl] no links found on this listing page — increment no-new counter");
        consecutiveNoNew++;
        if (consecutiveNoNew >= maxConsecutiveNoNew) {
          console.log(`[crawl] reached ${consecutiveNoNew} consecutive pages with no links — stopping.`);
          break;
        } else {
          pageIndex++;
          await sleep(1000 + Math.random() * 1000);
          continue;
        }
      }

      // Determine truly new links (not seen in this run, and not present in Dynamo)
      const newLinks = links.filter((l) => {
        try {
          const parts = new URL(l).pathname.split("/").filter(Boolean);
          const last = parts[parts.length - 1] || l;
          const candidateJobId = `weworkremotely-${last}`;
          if (existingJobIds.has(candidateJobId)) return false;
          if (seenUrls.has(l)) return false;
          return true;
        } catch (e) {
          return false;
        }
      });

      if (newLinks.length === 0) {
        console.log("[crawl] page had links but none are new (all stored or seen) — increment no-new counter");
        consecutiveNoNew++;
        if (consecutiveNoNew >= maxConsecutiveNoNew) {
          console.log(`[crawl] reached ${consecutiveNoNew} consecutive pages with no new links — stopping.`);
          break;
        }
        pageIndex++;
        await sleep(1000 + Math.random() * 1200);
        continue;
      }

      // Reset consecutive counter because we found new links
      consecutiveNoNew = 0;

      // Process all new links on this page
      for (const link of newLinks) {
        try {
          seenUrls.add(link); // mark seen in this run
          const job = await parseJobDetail(page, link);
          if (job) {
            if (!existingJobIds.has(job.jobId)) {
              buffer.push(job);
              existingJobIds.add(job.jobId); // avoid duplicates across pages
            } else {
              console.log("[crawl] job was discovered during this run by another page, skipping:", job.jobId);
            }
          } else {
            console.warn("[crawl] parse returned null for", link);
          }
        } catch (err) {
          console.error("[crawl] error parsing job", link, err && err.stack ? err.stack : err);
        }

        // flush periodically
        if (buffer.length >= 20) {
          const chunk = buffer.splice(0, 20);
          const uniqueChunk = uniqueByJobId(chunk);
          if (uniqueChunk.length > 0) {
            try {
              console.log(`[crawl] batchUpsert ${uniqueChunk.length} new jobs to DynamoDB...`);
              await batchUpsert(uniqueChunk);
              console.log("[crawl] batchUpsert success");
            } catch (err) {
              console.error("[crawl] batchUpsert failed", err && err.stack ? err.stack : err);
              buffer.unshift(...uniqueChunk);
              await sleep(2000);
            }
          }
        }

        await sleep(500 + Math.random() * 800); // per-job polite delay (smaller to increase throughput)
      }

      // finished this page; move to next
      pageIndex++;
      await sleep(800 + Math.random() * 1200); // between pages
    }

    // final flush any remaining new jobs
    if (buffer.length) {
      const finalChunk = buffer.splice(0);
      const uniqueFinal = uniqueByJobId(finalChunk);
      if (uniqueFinal.length > 0) {
        try {
          console.log(`[crawl] final batchUpsert of ${uniqueFinal.length} new jobs...`);
          await batchUpsert(uniqueFinal);
          console.log("[crawl] final flush success");
        } catch (err) {
          console.error("[crawl] final batchUpsert failed", err && err.stack ? err.stack : err);
        }
      }
    }

    console.log("[crawl] finished successfully (full-run)");
  } catch (err) {
    console.error("[crawlWeWorkRemotely] top-level error:", err && err.stack ? err.stack : err);
    throw err;
  } finally {
    try {
      if (context) await context.close();
    } catch (e) {}
    try {
      if (browser) await browser.close();
    } catch (e) {}
  }
}
