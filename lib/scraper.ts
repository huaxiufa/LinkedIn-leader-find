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

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map(clean).find(Boolean) ?? "";
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

  const versionUrl = `http://${cdpHost}:${configured.port || "9222"}`;
  const versionEndpoint = `${versionUrl}/json/version`;
  console.log(`Connecting to existing Chrome CDP via ${versionEndpoint}`);

  const response = await fetch(versionEndpoint, { headers: { Host: cdpHost } });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Chrome CDP endpoint returned HTTP ${response.status} at ${versionEndpoint}${detail ? `: ${clean(detail)}` : ""}`);
  }

  const version = (await response.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome CDP /json/version did not provide webSocketDebuggerUrl.");
  console.log(`Chrome CDP browser: ${version.Browser ?? "unknown"}`);
  console.log(`Connecting Playwright to Chrome CDP endpoint: ${versionUrl}`);

  const browser = await chromium.connectOverCDP(versionUrl, { timeout: 120000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP is connected, but no browser context is available.");

  const page = await context.newPage();
  console.log("Created dedicated LinkedIn scraping tab; existing Chrome tabs remain untouched.");
  return { browser, context, page };
}

async function extractPersonFromContainer(container: Element, fallbackHref?: string) {
  const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));
  const anchor = anchors[0];
  const href = normalizeLinkedInUrl(anchor?.href || fallbackHref || "");
  if (!href.includes("linkedin.com/in/")) return null;

  const anchorText = clean(anchor?.textContent);
  const aria = clean(anchor?.getAttribute("aria-label"));
  const fullText = clean(container.textContent);
  const lines = (container.textContent ?? "")
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);

  const name = firstNonEmpty(anchorText, aria, lines[0]);
  if (!name) return null;

  // LinkedIn commonly renders the person's headline directly below the name
  // in the same comment/reaction list item. Use visible text only; never open
  // the profile page to enrich it.
  const nameIndex = lines.findIndex((line) => line === name);
  let headline = "";
  if (nameIndex >= 0) {
    headline = lines.slice(nameIndex + 1).find((line) => {
      if (!line || line === name) return false;
      if (/^(follow|connect|message|like|reply|more|reacted|1st|2nd|3rd\+?)$/i.test(line)) return false;
      return line.length >= 3;
    }) ?? "";
  }

  if (!headline) {
    const titleLike = container.querySelector<HTMLElement>(
      '.feed-shared-actor__description, .comments-comment-item__main-content, [class*="actor__description"], [class*="headline"]'
    );
    headline = clean(titleLike?.textContent);
  }

  return {
    profileUrl: href,
    name,
    headline: headline || undefined,
    rawText: fullText,
  };
}

async function collectReactionPeople(page: Page, max: number) {
  const seen = new Set<string>();
  const results: Array<{ profileUrl: string; name: string; headline?: string }> = [];

  for (let round = 0; round < 40 && results.length < max; round++) {
    const people = await page.locator('[role="dialog"] li, [role="dialog"] [role="listitem"], [role="dialog"] div').evaluateAll((els) =>
      els.map((el) => {
        const anchors = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));
        if (!anchors.length) return null;
        return {
          href: anchors[0].href,
          text: anchors[0].textContent ?? "",
          containerText: el.textContent ?? "",
        };
      }).filter(Boolean)
    );

    for (const person of people) {
      if (!person) continue;
      const href = normalizeLinkedInUrl(person.href);
      if (!href.includes("linkedin.com/in/") || seen.has(href)) continue;
      seen.add(href);

      const container = page.locator(`a[href="${person.href}"]`).first();
      const data = await container.evaluate((anchor) => {
        const parent = anchor.closest("li, [role=listitem]") ?? anchor.parentElement;
        if (!parent) return { name: anchor.textContent ?? "", headline: "" };
        const lines = (parent.textContent ?? "").split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        const name = (anchor.textContent ?? "").replace(/\s+/g, " ").trim() || lines[0] || "";
        const index = lines.findIndex((x) => x === name);
        const headline = index >= 0 ? (lines.slice(index + 1).find((x) => x.length >= 3 && !/^(follow|connect|message|more|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
        return { name, headline };
      }).catch(() => ({ name: person.text, headline: "" }));

      results.push({ profileUrl: href, name: clean(data.name) || "Unknown", headline: clean(data.headline) || undefined });
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
    await page.waitForTimeout(700);
  }

  return results;
}

export async function scrapePublicPost(
  postUrl: string,
  options: { maxComments?: number; maxReactions?: number } = {}
): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];
  const { page } = await connectToLinkedInBrowser();

  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);

    const bodyText = clean(await page.locator("body").textContent().catch(() => ""));
    if (/sign in|join linkedin|log in/i.test(bodyText)) {
      warnings.push("The connected Windows Chrome session appears to be signed out of LinkedIn. Log into LinkedIn in that Chrome window and retry.");
    }

    // Comments: read the profile URL + visible name + visible headline from the
    // comment item itself. No customer profile navigation is performed.
    const commentBlocks = page.locator('[data-test-id*="comment"], .comments-comment-item, [class*="comments-comment-item"], [class*="comment-item"]');
    const count = Math.min(await commentBlocks.count().catch(() => 0), maxComments);

    for (let i = 0; i < count; i++) {
      const block = commentBlocks.nth(i);
      const data = await block.evaluate((el) => {
        const anchor = el.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
        if (!anchor) return null;
        const lines = (el.textContent ?? "").split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        const name = (anchor.textContent ?? "").replace(/\s+/g, " ").trim() || anchor.getAttribute("aria-label") || lines[0] || "";
        const idx = lines.findIndex((x) => x === name);
        const headline = idx >= 0 ? (lines.slice(idx + 1).find((x) => x.length >= 3 && !/^(like|reply|more|follow|connect|message|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
        return { href: anchor.href, name, headline, text: el.textContent ?? "" };
      }).catch(() => null);

      if (!data) continue;
      const profileUrl = normalizeLinkedInUrl(data.href);
      if (!profileUrl.includes("linkedin.com/in/")) continue;
      const name = clean(data.name);
      if (!name) continue;

      engagements.push({
        profileUrl,
        name,
        headline: clean(data.headline) || undefined,
        jobTitle: clean(data.headline) || undefined,
        type: "COMMENT",
        commentText: clean(data.text).slice(0, 5000),
      });
    }

    // Reactions: read users and visible headline text from the reaction dialog.
    const reactionDialogTriggers = page.getByRole("button", { name: /people who reacted|reactions|reaction(s)?\s*\d+/i });
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
      const people = await collectReactionPeople(page, options.maxReactions ?? 500);
      for (const person of people) {
        engagements.push({
          profileUrl: person.profileUrl,
          name: person.name,
          headline: person.headline,
          jobTitle: person.headline,
          type: "REACTION",
          reactionType: "UNKNOWN",
        });
      }
      if (!people.length) {
        warnings.push("The reaction panel opened, but no public /in/ profile links were exposed. Check the logged-in Chrome session and whether LinkedIn exposes the reaction list to this account.");
      }
    } else {
      warnings.push("A reaction-user list trigger was not exposed by the page.");
    }

    // One record per LinkedIn profile. Prefer the record containing headline data.
    const deduped = new Map<string, ScrapedEngagement>();
    for (const item of engagements) {
      const key = item.profileUrl.toLowerCase();
      const existing = deduped.get(key);
      if (!existing || (!existing.headline && item.headline)) {
        deduped.set(key, item);
      }
    }

    return { engagements: [...deduped.values()], warnings };
  } finally {
    await page.close().catch(() => {});
  }
}
