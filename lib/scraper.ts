import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { lookup } from "node:dns/promises";
import { normalizeLinkedInUrl } from "./normalize";

export type ScrapedEngagement = {
  profileUrl: string;
  name: string;
  headline?: string;
  jobTitle?: string;
  company?: string;
  type: "COMMENT" | "REACTION";
  reactionType?: string;
  commentText?: string;
  engagedAt?: Date;
};

export type ScrapeResult = {
  engagements: ScrapedEngagement[];
  warnings: string[];
};

function clean(s: string | undefined | null) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function inferJobTitle(headline?: string) {
  const h = clean(headline);
  if (!h) return undefined;
  return h;
}

async function connectToLinkedInBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const configuredUrl = process.env.LINKEDIN_CDP_URL ?? "http://host.docker.internal:9222";
  const configured = new URL(configuredUrl);

  let cdpHost = configured.hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(cdpHost) && cdpHost !== "localhost") {
    const addresses = await lookup(cdpHost, { all: true });
    const ipv4 = addresses.find((entry) => entry.family === 4);
    if (!ipv4) throw new Error(`Could not resolve ${cdpHost} to an IPv4 address from the Docker container.`);
    cdpHost = ipv4.address;
  }

  const versionUrl = `http://${cdpHost}:${configured.port || "9222"}/json/version`;
  console.log(`Connecting to existing Chrome CDP via ${versionUrl}`);

  const response = await fetch(versionUrl, {
    headers: { Host: cdpHost },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Chrome CDP endpoint returned HTTP ${response.status} at ${versionUrl}${detail ? `: ${clean(detail)}` : ""}`
    );
  }

  const version = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP /json/version did not provide webSocketDebuggerUrl.");
  }

  const wsUrl = version.webSocketDebuggerUrl.replace(
    /^ws:\/\/(localhost|127\.0\.0\.1)(?=:|\/)/i,
    `ws://${cdpHost}`
  );

  console.log(`Connecting to Chrome CDP websocket: ${wsUrl}`);
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP is connected, but no browser context is available.");

  // Always create a new tab. Never navigate the user's currently active tab.
  const page = await context.newPage();
  console.log("Created dedicated LinkedIn scraping tab; existing Chrome tabs remain untouched.");
  return { browser, context, page };
}

async function collectReactionLinks(page: Page, max: number) {
  const seen = new Set<string>();
  const results: { href: string; text: string }[] = [];

  for (let round = 0; round < 30 && results.length < max; round++) {
    const links = await page.locator('a[href*="/in/"]').evaluateAll((els) =>
      els.map((e) => ({
        href: (e as HTMLAnchorElement).href,
        text: (e.textContent ?? "").trim(),
      }))
    );

    for (const item of links) {
      const href = normalizeLinkedInUrl(item.href);
      if (!href.includes("linkedin.com/in/") || seen.has(href)) continue;
      seen.add(href);
      results.push({ href, text: clean(item.text) });
      if (results.length >= max) break;
    }

    if (results.length >= max) break;

    const scrolled = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
      const target = dialogs.find((el) => el.scrollHeight > el.clientHeight) ??
        Array.from(document.querySelectorAll<HTMLElement>('[class*="artdeco-modal__content"], [class*="overflow-y-auto"]'))
          .find((el) => el.scrollHeight > el.clientHeight);
      if (!target) return false;
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + target.clientHeight * 0.85, target.scrollHeight);
      return target.scrollTop > before;
    }).catch(() => false);

    if (!scrolled) break;
    await page.waitForTimeout(800);
  }

  return results;
}

async function readProfileSummary(context: BrowserContext, url: string) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(700);

    const name = clean(await page.locator("h1").first().textContent().catch(() => ""));
    const headline = clean(
      await page
        .locator("main .text-body-medium, main [class*='headline']")
        .first()
        .textContent()
        .catch(() => "")
    );

    return {
      name: name || "Unknown",
      headline: headline || undefined,
      jobTitle: inferJobTitle(headline),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapePublicPost(
  postUrl: string,
  options: { maxComments?: number; maxReactions?: number } = {}
): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];

  const { context, page } = await connectToLinkedInBrowser();

  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const bodyText = clean(await page.locator("body").textContent().catch(() => ""));
    const signedIn = !/sign in|join linkedin|log in/i.test(bodyText);
    if (!signedIn) {
      warnings.push("The connected Windows Chrome session appears to be signed out of LinkedIn. Log into LinkedIn in that Chrome window and retry.");
    }

    const commentBlocks = page.locator('[data-test-id*="comment"], article, [class*="comment"]');
    const count = Math.min(await commentBlocks.count().catch(() => 0), maxComments);

    for (let i = 0; i < count; i++) {
      const block = commentBlocks.nth(i);
      const profile = block.locator('a[href*="/in/"]').first();
      const href = await profile.getAttribute("href").catch(() => null);
      if (!href) continue;

      const profileUrl = normalizeLinkedInUrl(href);
      if (!profileUrl.includes("/in/")) continue;

      const name = clean(await profile.textContent().catch(() => ""));
      const text = clean(await block.textContent().catch(() => ""));
      if (!name) continue;

      engagements.push({ profileUrl, name, type: "COMMENT", commentText: text.slice(0, 5000) });
    }

    const reactionDialogTriggers = page.getByRole("button", {
      name: /people who reacted|reactions|reaction(s)?\s*\d+/i,
    });

    let reactionTriggerCount = await reactionDialogTriggers.count().catch(() => 0);
    if (reactionTriggerCount) {
      await reactionDialogTriggers.first().click().catch(() => {});
    } else {
      const candidates = page.locator('[aria-label*="reaction" i], [aria-label*="people who reacted" i], [data-test-id*="reaction" i]');
      reactionTriggerCount = await candidates.count().catch(() => 0);
      if (reactionTriggerCount) await candidates.first().click().catch(() => {});
    }

    if (reactionTriggerCount) {
      await page.waitForTimeout(1200);
      const reactionLinks = await collectReactionLinks(page, options.maxReactions ?? 500);
      for (const link of reactionLinks) {
        engagements.push({ profileUrl: link.href, name: link.text || "Unknown", type: "REACTION", reactionType: "UNKNOWN" });
      }
      if (!reactionLinks.length) {
        warnings.push("The reaction panel opened, but no public /in/ profile links were exposed. Check the logged-in Chrome session and whether LinkedIn exposes the reaction list to this account.");
      }
    } else {
      warnings.push("A reaction-user list trigger was not exposed by the page.");
    }

    const uniqueUrls = [...new Set(engagements.map((x) => x.profileUrl))].slice(0, 200);
    const profiles = new Map<string, { name: string; headline?: string; jobTitle?: string }>();

    for (const url of uniqueUrls) {
      try {
        profiles.set(url, await readProfileSummary(context, url));
      } catch {
        // Keep data already collected from the post.
      }
    }

    for (const item of engagements) {
      const p = profiles.get(item.profileUrl);
      if (p) {
        item.name = p.name !== "Unknown" ? p.name : item.name;
        item.headline = p.headline;
        item.jobTitle = p.jobTitle;
      }
    }

    const deduped = new Map<string, ScrapedEngagement>();
    for (const item of engagements) {
      const key = `${item.profileUrl}|${item.type}`;
      if (!deduped.has(key)) deduped.set(key, item);
    }

    return { engagements: [...deduped.values()], warnings };
  } finally {
    // Close only the temporary scraping tab. Never close the user's Chrome.
    await page.close().catch(() => {});
  }
}
