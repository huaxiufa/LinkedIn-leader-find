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

export type ScrapeResult = { engagements: ScrapedEngagement[]; warnings: string[] };

function clean(s: string | undefined | null) { return (s ?? "").replace(/\s+/g, " ").trim(); }
function firstNonEmpty(...v: Array<string | null | undefined>) { return v.map(clean).find(Boolean) ?? ""; }

async function connectToLinkedInBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const configured = new URL(process.env.LINKEDIN_CDP_URL ?? "http://host.docker.internal:9222");
  let cdpHost = configured.hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(cdpHost) && cdpHost !== "localhost") {
    const addresses = await lookup(cdpHost, { all: true });
    const ipv4 = addresses.find((entry) => entry.family === 4);
    if (!ipv4) throw new Error(`Could not resolve ${cdpHost} to IPv4.`);
    cdpHost = ipv4.address;
  }
  const endpoint = `http://${cdpHost}:${configured.port || "9222"}`;
  const response = await fetch(`${endpoint}/json/version`, { headers: { Host: cdpHost } });
  if (!response.ok) throw new Error(`Chrome CDP endpoint returned HTTP ${response.status}.`);
  const version = await response.json() as { Browser?: string };
  console.log(`Chrome CDP browser: ${version.Browser ?? "unknown"}`);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 120000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connected, but no browser context is available.");
  const page = await context.newPage();
  console.log("Created dedicated LinkedIn scraping tab; existing Chrome tabs remain untouched.");
  return { browser, context, page };
}

function extractPerson(container: Element, fallbackHref = "") {
  const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]'));
  const anchor = links[0];
  const href = normalizeLinkedInUrl(anchor?.href || anchor?.getAttribute("data-test-profile-url") || anchor?.getAttribute("data-profile-url") || fallbackHref);
  if (!href.includes("linkedin.com/in/")) return null;

  const lines = (container.textContent ?? "").split(/\n+/).map(clean).filter(Boolean);
  const name = firstNonEmpty(anchor?.textContent, anchor?.getAttribute("aria-label"), lines[0]);
  if (!name) return null;
  const idx = lines.findIndex(x => x === name);
  const headline = idx >= 0 ? (lines.slice(idx + 1).find(x => x.length >= 3 && !/^(follow|connect|message|more|like|reply|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
  return { profileUrl: href, name, headline: headline || undefined };
}

async function collectReactionPeople(page: Page, max: number) {
  const seen = new Set<string>();
  const results: Array<{ profileUrl: string; name: string; headline?: string }> = [];

  for (let round = 0; round < 50 && results.length < max; round++) {
    const cards = page.locator('[role="dialog"] li, [role="dialog"] [role="listitem"], [role="dialog"] [data-view-name], [role="dialog"] .mn-pymk-list__card, [role="dialog"] div');
    const count = await cards.count().catch(() => 0);
    let discoveredThisRound = 0;

    for (let i = 0; i < count && results.length < max; i++) {
      const data = await cards.nth(i).evaluate((el) => {
        const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]'));
        if (!links.length) return null;
        const anchor = links[0];
        const href = anchor.href || anchor.getAttribute("data-test-profile-url") || anchor.getAttribute("data-profile-url") || "";
        const lines = (el.textContent ?? "").split(/\n+/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        const name = (anchor.textContent ?? "").replace(/\s+/g, " ").trim() || anchor.getAttribute("aria-label") || lines[0] || "";
        const idx = lines.findIndex(x => x === name);
        const headline = idx >= 0 ? (lines.slice(idx + 1).find(x => x.length >= 3 && !/^(follow|connect|message|more|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
        return { href, name, headline };
      }).catch(() => null);
      if (!data) continue;
      const href = normalizeLinkedInUrl(data.href);
      if (!href.includes("linkedin.com/in/") || seen.has(href)) continue;
      seen.add(href);
      results.push({ profileUrl: href, name: clean(data.name) || "Unknown", headline: clean(data.headline) || undefined });
      discoveredThisRound++;
    }

    if (results.length >= max) break;

    const scrollResult = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
      const candidates = dialogs.flatMap(d => [d, ...Array.from(d.querySelectorAll<HTMLElement>('div, ul, ol'))]);
      const target = candidates.filter(el => el.scrollHeight > el.clientHeight + 20).sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
      if (!target) return { scrolled: false, dialogText: dialogs.map(d => d.innerText).join("\n").slice(0, 3000), anchors: document.querySelectorAll('[role="dialog"] a').length };
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + Math.max(300, target.clientHeight * 0.9), target.scrollHeight);
      return { scrolled: target.scrollTop > before, dialogText: dialogs.map(d => d.innerText).join("\n").slice(0, 3000), anchors: document.querySelectorAll('[role="dialog"] a').length };
    }).catch(() => ({ scrolled: false, dialogText: "", anchors: 0 }));

    if (!scrollResult.scrolled) {
      if (!results.length) {
        const diagnostics = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return {
            dialogCount: document.querySelectorAll('[role="dialog"]').length,
            links: dialog ? Array.from(dialog.querySelectorAll<HTMLAnchorElement>('a')).slice(0, 20).map(a => ({ href: a.href, text: clean(a.textContent), aria: a.getAttribute("aria-label"), cls: a.className })) : [],
            text: dialog ? clean(dialog.textContent).slice(0, 2500) : ""
          };
        }).catch(() => null);
        console.log("Reaction dialog diagnostics:", JSON.stringify(diagnostics));
      }
      break;
    }
    await page.waitForTimeout(700);
    if (!discoveredThisRound && round > 5) break;
  }
  return results;
}

export async function scrapePublicPost(postUrl: string, options: { maxComments?: number; maxReactions?: number } = {}): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];
  const { page } = await connectToLinkedInBrowser();

  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const bodyText = clean(await page.locator("body").textContent().catch(() => ""));
    if (/sign in|join linkedin|log in/i.test(bodyText)) warnings.push("The connected Windows Chrome session appears to be signed out of LinkedIn. Log into LinkedIn in that Chrome window and retry.");

    const commentBlocks = page.locator('[data-test-id*="comment"], .comments-comment-item, [class*="comments-comment-item"], [class*="comment-item"]');
    const count = Math.min(await commentBlocks.count().catch(() => 0), maxComments);
    for (let i = 0; i < count; i++) {
      const data = await commentBlocks.nth(i).evaluate(el => {
        const p = extractPerson(el);
        return p ? { ...p, text: el.textContent ?? "" } : null;
      }).catch(() => null);
      if (!data) continue;
      engagements.push({ profileUrl: data.profileUrl, name: data.name, headline: data.headline, jobTitle: data.headline, type: "COMMENT", commentText: clean(data.text).slice(0, 5000) });
    }

    const triggers = page.getByRole("button", { name: /people who reacted|reactions|reaction(s)?\s*\d+/i });
    let triggerCount = await triggers.count().catch(() => 0);
    if (triggerCount) await triggers.first().click().catch(() => {});
    else {
      const candidates = page.locator('[aria-label*="reaction" i], [aria-label*="people who reacted" i], [data-test-id*="reaction" i]');
      triggerCount = await candidates.count().catch(() => 0);
      if (triggerCount) await candidates.first().click().catch(() => {});
    }

    if (triggerCount) {
      await page.waitForTimeout(1500);
      const people = await collectReactionPeople(page, options.maxReactions ?? 500);
      for (const person of people) engagements.push({ profileUrl: person.profileUrl, name: person.name, headline: person.headline, jobTitle: person.headline, type: "REACTION", reactionType: "UNKNOWN" });
      if (!people.length) warnings.push("Reaction dialog opened but LinkedIn did not expose profile links in its DOM. Diagnostics were logged by the worker; no customer profile pages were opened.");
    } else warnings.push("A reaction-user list trigger was not exposed by the page.");

    const deduped = new Map<string, ScrapedEngagement>();
    for (const item of engagements) {
      const key = item.profileUrl.toLowerCase();
      const existing = deduped.get(key);
      if (!existing || (!existing.headline && item.headline)) deduped.set(key, item);
    }
    return { engagements: [...deduped.values()], warnings };
  } finally {
    await page.close().catch(() => {});
  }
}
