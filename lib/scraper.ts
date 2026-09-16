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
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal, [data-test-modal]'));
      const candidates = dialogs.flatMap(d => [d, ...Array.from(d.querySelectorAll<HTMLElement>('div, ul, ol'))]);
      const target = candidates.filter(el => el.scrollHeight > el.clientHeight + 20).sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
      const dialogText = dialogs.map(d => d.innerText).join("\n").slice(0, 3000);
      const anchors = dialogs.reduce((n, d) => n + d.querySelectorAll('a').length, 0);
      if (!target) return { scrolled: false, dialogText, anchors };
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + Math.max(300, target.clientHeight * 0.9), target.scrollHeight);
      return { scrolled: target.scrollTop > before, dialogText, anchors };
    }).catch(() => ({ scrolled: false, dialogText: "", anchors: 0 }));

    if (!scrollResult.scrolled) break;
    await page.waitForTimeout(700);
    if (!discoveredThisRound && round > 5) break;
  }

  if (results.length < max) {
    const opened = await collectReactionPeopleByOpening(page, max - results.length, seen);
    results.push(...opened);
  }

  return results;
}

async function collectReactionPeopleByOpening(page: Page, max: number, seen: Set<string>) {
  const results: Array<{ profileUrl: string; name: string; headline?: string }> = [];
  const dialog = page.locator('[role="dialog"], .artdeco-modal, [data-test-modal], [data-test-dialog]').filter({ visible: true }).first();
  if (!await dialog.count().catch(() => 0)) return results;

  const candidates = dialog.locator('a, [role="link"], button, [role="button"]');
  const count = Math.min(await candidates.count().catch(() => 0), 1000);
  const visitedNames = new Set<string>();

  for (let i = 0; i < count && results.length < max; i++) {
    const candidate = candidates.nth(i);
    const meta = await candidate.evaluate(el => ({
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      aria: el.getAttribute("aria-label") ?? "",
      title: el.getAttribute("title") ?? "",
      href: (el as HTMLAnchorElement).href ?? ""
    })).catch(() => null);
    if (!meta) continue;

    const name = clean(meta.text || meta.aria || meta.title);
    if (!name || name.length < 2 || name.length > 120 || visitedNames.has(name)) continue;
    if (/^(like|comment|share|send|follow|connect|message|more|close|back|next|previous|sort|filter|search|reactions?|see all)$/i.test(name)) continue;
    visitedNames.add(name);

    const directHref = normalizeLinkedInUrl(meta.href);
    if (directHref.includes("linkedin.com/in/") && !seen.has(directHref)) {
      seen.add(directHref);
      results.push({ profileUrl: directHref, name });
      continue;
    }

    const beforeUrl = page.url();
    let popup: Page | undefined;
    try {
      popup = await page.waitForEvent("popup", { timeout: 1200 }).catch(() => undefined);
      await candidate.click({ timeout: 3000 });
      await page.waitForTimeout(900);
    } catch {
      if (popup) await popup.close().catch(() => {});
      continue;
    }

    const targetPage = popup && !popup.isClosed() ? popup : page;
    const targetUrl = normalizeLinkedInUrl(targetPage.url());
    if (targetUrl.includes("linkedin.com/in/") && !seen.has(targetUrl)) {
      seen.add(targetUrl);
      results.push({ profileUrl: targetUrl, name });
    }

    if (popup && !popup.isClosed()) {
      await popup.close().catch(() => {});
    } else if (page.url() !== beforeUrl) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    const closeButton = page.getByRole("button", { name: /close/i }).last();
    if (await closeButton.count().catch(() => 0)) {
      await closeButton.click({ timeout: 1000 }).catch(() => {});
    }
  }

  return results;
}

async function inspectReactionSurface(page: Page) {
  const script = `(function () {
    function compact(value) { return (value || "").replace(/\\s+/g, " ").trim(); }
    var surfaces = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal, [data-test-modal], [data-test-dialog]'));
    var surface = surfaces[0];
    var links = surface ? Array.from(surface.querySelectorAll('a')).slice(0, 50).map(function (a) {
      return { href: a.href, text: compact(a.textContent), aria: a.getAttribute('aria-label'), title: a.getAttribute('title') };
    }) : [];
    var buttons = surface ? Array.from(surface.querySelectorAll('button')).slice(0, 50).map(function (b) {
      return { text: compact(b.textContent), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), dataView: b.getAttribute('data-view-name') };
    }) : [];
    var candidateAttributes = surface ? Array.from(surface.querySelectorAll('*')).flatMap(function (el) {
      return Array.from(el.attributes).filter(function (a) {
        return /href|profile|member|entity|urn|actor|user|person/i.test(a.name) || /linkedin\\.com\\/in\\//i.test(a.value);
      }).map(function (a) { return { name: a.name, value: a.value.slice(0, 500) }; });
    }).slice(0, 120) : [];
    var text = compact(surface ? surface.innerText : '').slice(0, 5000);
    return {
      surfaceCount: surfaces.length,
      surfaceTag: surface ? surface.tagName : '',
      surfaceClass: surface ? String(surface.className || '') : '',
      text: text,
      links: links,
      buttons: buttons,
      candidateAttributes: candidateAttributes,
      bodyProfileLinks: document.querySelectorAll('a[href*="/in/"]').length
    };
  })()`;
  return page.evaluate(script).catch(error => ({ error: String(error) }));
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
      const surface = await inspectReactionSurface(page);
      console.log("Reaction surface snapshot:", JSON.stringify(surface));

      const people = await collectReactionPeople(page, options.maxReactions ?? 500);
      for (const person of people) engagements.push({ profileUrl: person.profileUrl, name: person.name, headline: person.headline, jobTitle: person.headline, type: "REACTION", reactionType: "UNKNOWN" });
      if (!people.length) warnings.push("Reaction dialog opened but no LinkedIn profile URL could be captured. The worker tried normal profile clicks and did not bypass any access controls.");
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
