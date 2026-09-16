import { chromium, type Browser, type Page } from "playwright";
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

async function collectReactionLinks(page: Page, max: number) {
  const seen = new Set<string>();
  const results: { href: string; text: string }[] = [];

  for (let round = 0; round < 8 && results.length < max; round++) {
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
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"] [class*="artdeco-modal__content"], [role="dialog"] [class*="overflow-y-auto"], [role="dialog"]'
      ));
      const target = candidates.find((el) => el.scrollHeight > el.clientHeight);
      if (!target) return false;
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + target.clientHeight * 0.85, target.scrollHeight);
      return target.scrollTop > before;
    }).catch(() => false);

    if (!scrolled) break;
    await page.waitForTimeout(500);
  }

  return results;
}

async function readProfileSummary(page: Page, url: string) {
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
}

export async function scrapePublicPost(
  postUrl: string,
  options: { maxComments?: number; maxReactions?: number } = {}
): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];

  const browser: Browser = await chromium.launch({
    headless: process.env.SCRAPER_HEADLESS !== "false",
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
    });

    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);

    const bodyText = clean(await page.locator("body").textContent().catch(() => ""));
    if (/sign in|join linkedin|log in/i.test(bodyText)) {
      warnings.push(
        "LinkedIn is showing a sign-in gate. Only data visible without bypassing that gate can be collected."
      );
    }

    const commentBlocks = page.locator(
      '[data-test-id*="comment"], article, [class*="comment"]'
    );
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

      engagements.push({
        profileUrl,
        name,
        type: "COMMENT",
        commentText: text.slice(0, 5000),
      });
    }

    // Do NOT match the normal Like button here. The previous selector could
    // click the post's Like action instead of opening the reaction-user list.
    const reactionDialogTriggers = page.getByRole("button", {
      name: /people who reacted|reactions|reaction(s)?\s*\d+/i,
    });

    let reactionTriggerCount = await reactionDialogTriggers.count().catch(() => 0);

    if (!reactionTriggerCount) {
      // LinkedIn sometimes renders the reaction count as a link/span rather
      // than a button. Look for accessible text without targeting the Like action.
      const candidates = page.locator(
        '[aria-label*="reaction" i], [aria-label*="people who reacted" i], [data-test-id*="reaction" i]'
      );
      reactionTriggerCount = await candidates.count().catch(() => 0);
      if (reactionTriggerCount) {
        await candidates.first().click().catch(() => {});
      }
    } else {
      await reactionDialogTriggers.first().click().catch(() => {});
    }

    if (reactionTriggerCount) {
      await page.waitForTimeout(1000);

      const reactionLinks = await collectReactionLinks(page, options.maxReactions ?? 500);
      for (const link of reactionLinks) {
        engagements.push({
          profileUrl: link.href,
          name: link.text || "Unknown",
          type: "REACTION",
          reactionType: "UNKNOWN",
        });
      }

      if (!reactionLinks.length) {
        warnings.push(
          "The reaction panel opened, but no public /in/ profile links were exposed in it. LinkedIn may be limiting the visible reaction users."
        );
      }
    } else {
      warnings.push(
        "A public reaction-user list was not exposed by the page, so reaction users may be incomplete."
      );
    }

    const uniqueUrls = [...new Set(engagements.map((x) => x.profileUrl))].slice(0, 100);
    const profiles = new Map<string, { name: string; headline?: string; jobTitle?: string }>();

    for (const url of uniqueUrls) {
      try {
        profiles.set(url, await readProfileSummary(page, url));
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
    await browser.close();
  }
}
