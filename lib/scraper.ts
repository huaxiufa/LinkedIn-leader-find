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
function isProfileUrl(url: string) { return /linkedin\.com\/in\//i.test(normalizeLinkedInUrl(url)); }

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
  if (!isProfileUrl(href)) return null;
  const lines = (container.textContent ?? "").split(/\n+/).map(clean).filter(Boolean);
  const name = firstNonEmpty(anchor?.textContent, anchor?.getAttribute("aria-label"), lines[0]);
  if (!name) return null;
  const idx = lines.findIndex(x => x === name);
  const headline = idx >= 0 ? (lines.slice(idx + 1).find(x => x.length >= 3 && !/^(follow|connect|message|more|like|reply|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
  return { profileUrl: href, name, headline: headline || undefined };
}

async function collectProfileLinks(page: Page, seen: Set<string>, type: "COMMENT" | "REACTION", limit: number) {
  const found: ScrapedEngagement[] = await page.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]').evaluateAll((anchors, type) => {
    const rows: ScrapedEngagement[] = [];
    for (const anchor of anchors) {
      const a = anchor as HTMLAnchorElement;
      const href = a.href || a.getAttribute("data-test-profile-url") || a.getAttribute("data-profile-url") || "";
      if (!/linkedin\.com\/in\//i.test(href)) continue;
      const row = a.closest('li, [role="listitem"], article, [data-view-name], [data-test-id], .comments-comment-item, [class*="comment-item"]') || a.parentElement || a;
      const lines = (row.textContent ?? "").split(/\n+/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
      const name = (a.textContent ?? "").replace(/\s+/g, " ").trim() || a.getAttribute("aria-label") || lines[0] || "";
      const idx = lines.findIndex(x => x === name);
      const headline = idx >= 0 ? (lines.slice(idx + 1).find(x => x.length >= 3 && !/^(follow|connect|message|more|like|reply|1st|2nd|3rd\+?)$/i.test(x)) ?? "") : "";
      rows.push({ profileUrl: href, name, headline: headline || undefined, jobTitle: headline || undefined, type, reactionType: type === "REACTION" ? "UNKNOWN" : undefined, commentText: type === "COMMENT" ? (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 5000) : undefined });
    }
    return rows;
  }, type).catch(() => []);

  const result: ScrapedEngagement[] = [];
  for (const item of found) {
    const href = normalizeLinkedInUrl(item.profileUrl);
    if (!isProfileUrl(href) || seen.has(href.toLowerCase())) continue;
    seen.add(href.toLowerCase());
    result.push({ ...item, profileUrl: href });
    if (result.length >= limit) break;
  }
  return result;
}

async function reactionSurfaceSnapshot(page: Page) {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal, [data-test-modal], [data-test-dialog]'));
    const root = roots[0];
    const compact = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const clickable = root ? Array.from(root.querySelectorAll<HTMLElement>('a, button, [role="link"], [role="button"], [tabindex="0"]')).slice(0, 120).map(el => ({
      text: compact(el.textContent),
      aria: el.getAttribute("aria-label"),
      title: el.getAttribute("title"),
      href: (el as HTMLAnchorElement).href || el.getAttribute("data-test-profile-url") || el.getAttribute("data-profile-url"),
      control: el.getAttribute("data-control-name"),
      view: el.getAttribute("data-view-name"),
      test: el.getAttribute("data-test-id")
    })) : [];
    return {
      url: location.href,
      surfaceCount: roots.length,
      text: compact(root?.innerText).slice(0, 5000),
      links: root ? Array.from(root.querySelectorAll<HTMLAnchorElement>('a')).slice(0, 80).map(a => ({ href: a.href, text: compact(a.textContent), aria: a.getAttribute("aria-label") })) : [],
      clickable,
      profileLinksOnPage: document.querySelectorAll('a[href*="/in/"]').length
    };
  }).catch(error => ({ error: String(error) }));
}

async function closeTransientProfile(page: Page) {
  const buttons = page.getByRole("button", { name: /close/i });
  const count = await buttons.count().catch(() => 0);
  if (count) await buttons.last().click({ timeout: 1200 }).catch(() => {});
}

async function collectReactionPeople(page: Page, max: number, warnings: string[]) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];

  for (let round = 0; round < 60 && results.length < max; round++) {
    // First capture any normal /in/ links currently exposed by the reaction dialog.
    const direct = await collectProfileLinks(page, seen, "REACTION", max - results.length);
    results.push(...direct);
    if (results.length >= max) break;

    const snapshot = await reactionSurfaceSnapshot(page);
    if (round === 0) console.log("Reaction surface snapshot:", JSON.stringify(snapshot));

    const candidates = page.locator('[role="dialog"] a, [role="dialog"] [role="link"], [role="dialog"] button, [role="dialog"] [role="button"], [role="dialog"] [tabindex="0"], [role="dialog"] [data-control-name], [role="dialog"] [data-view-name], [role="dialog"] [data-test-id]');
    const count = Math.min(await candidates.count().catch(() => 0), 2500);
    let clicked = 0;

    // Re-query candidate metadata on every round because LinkedIn virtualizes reaction rows.
    for (let i = 0; i < count && results.length < max; i++) {
      const candidate = candidates.nth(i);
      const meta = await candidate.evaluate(el => ({
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") ?? "",
        title: el.getAttribute("title") ?? "",
        href: (el as HTMLAnchorElement).href ?? "",
        control: el.getAttribute("data-control-name") ?? "",
        view: el.getAttribute("data-view-name") ?? "",
        test: el.getAttribute("data-test-id") ?? ""
      })).catch(() => null);
      if (!meta) continue;

      const label = clean(meta.text || meta.aria || meta.title);
      if (!label || label.length < 2 || label.length > 160) continue;
      if (/^(like|comment|share|send|follow|connect|message|more|close|back|next|previous|sort|filter|search|reactions?|see all|people who reacted|button|link|tab|menuitem|listitem)$/i.test(label)) continue;

      const directHref = normalizeLinkedInUrl(meta.href);
      if (isProfileUrl(directHref) && !seen.has(directHref.toLowerCase())) {
        seen.add(directHref.toLowerCase());
        results.push({ profileUrl: directHref, name: label, type: "REACTION", reactionType: "UNKNOWN", jobTitle: undefined });
        continue;
      }

      // A reaction row can be a div/span with a click handler. Use only normal UI clicks;
      // never call private endpoints or fabricate a profile URL from a name.
      const beforeUrl = page.url();
      const beforePages = page.context().pages();
      try {
        await candidate.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
        const popupPromise = page.waitForEvent("popup", { timeout: 1200 }).catch(() => undefined);
        await candidate.click({ timeout: 3000, force: false }).catch(async () => candidate.click({ timeout: 1800, force: true }));
        const popup = await popupPromise;
        await page.waitForTimeout(900);
        clicked++;

        const pagesNow = page.context().pages();
        const newPage = pagesNow.find(p => !beforePages.includes(p) && !p.isClosed());
        const target = popup && !popup.isClosed() ? popup : (newPage ?? page);
        const targetUrl = normalizeLinkedInUrl(target.url());

        if (isProfileUrl(targetUrl) && !seen.has(targetUrl.toLowerCase())) {
          seen.add(targetUrl.toLowerCase());
          results.push({ profileUrl: targetUrl, name: label, type: "REACTION", reactionType: "UNKNOWN" });
          console.log(`Captured reaction profile URL by click: ${targetUrl}`);
        } else {
          // LinkedIn may open a profile card/modal without changing the URL.
          const modalLinks = await collectProfileLinks(target, seen, "REACTION", max - results.length);
          results.push(...modalLinks);
          if (modalLinks.length) console.log(`Captured ${modalLinks.length} reaction profile URL(s) from profile overlay.`);
        }

        if (popup && !popup.isClosed()) await popup.close().catch(() => {});
        if (newPage && !newPage.isClosed()) await newPage.close().catch(() => {});
        if (target === page && page.url() !== beforeUrl && !isProfileUrl(page.url())) {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        await closeTransientProfile(page);
      } catch {
        // Some reaction rows are not clickable; continue scanning the list.
      }
    }

    const scrolled = await page.evaluate(() => {
      const roots = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal, [data-test-modal], [data-test-dialog]'));
      const elements = roots.flatMap(root => [root, ...Array.from(root.querySelectorAll<HTMLElement>('div, ul, ol'))]);
      const target = elements.filter(el => el.scrollHeight > el.clientHeight + 20).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!target) return false;
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + Math.max(350, target.clientHeight * 0.9), target.scrollHeight);
      return target.scrollTop > before;
    }).catch(() => false);

    if (!scrolled && clicked === 0) break;
    await page.waitForTimeout(650);
    if (!scrolled && round > 2) break;
  }

  if (!results.length) {
    const snapshot = await reactionSurfaceSnapshot(page);
    warnings.push(`Reaction extraction found no profile URLs. Diagnostic: surface=${"surfaceCount" in snapshot ? snapshot.surfaceCount : "unknown"}, pageProfileLinks=${"profileLinksOnPage" in snapshot ? snapshot.profileLinksOnPage : "unknown"}.`);
  }
  return results;
}

async function collectComments(page: Page, max: number) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];
  const blocks = page.locator('[data-test-id*="comment" i], .comments-comment-item, [class*="comments-comment-item"], [class*="comment-item"], article');
  const count = Math.min(await blocks.count().catch(() => 0), max * 3);
  for (let i = 0; i < count && results.length < max; i++) {
    const data = await blocks.nth(i).evaluate(el => {
      const p = extractPerson(el);
      return p ? { ...p, text: el.textContent ?? "" } : null;
    }).catch(() => null);
    if (!data || seen.has(data.profileUrl.toLowerCase())) continue;
    seen.add(data.profileUrl.toLowerCase());
    results.push({ profileUrl: data.profileUrl, name: data.name, headline: data.headline, jobTitle: data.headline, type: "COMMENT", commentText: clean(data.text).slice(0, 5000) });
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

    const comments = await collectComments(page, maxComments);
    engagements.push(...comments);
    console.log(`Comment extraction: ${comments.length} profile(s) captured.`);

    const triggers = page.getByRole("button", { name: /people who reacted|reactions|reaction(s)?\s*\d+/i });
    let triggerCount = await triggers.count().catch(() => 0);
    if (triggerCount) {
      await triggers.first().click().catch(() => {});
    } else {
      const candidates = page.locator('[aria-label*="reaction" i], [aria-label*="people who reacted" i], [data-test-id*="reaction" i], [data-view-name*="reaction" i]');
      triggerCount = await candidates.count().catch(() => 0);
      if (triggerCount) await candidates.first().click().catch(() => {});
    }

    if (triggerCount) {
      await page.waitForTimeout(1200);
      const reactions = await collectReactionPeople(page, options.maxReactions ?? 500, warnings);
      engagements.push(...reactions);
      console.log(`Reaction extraction: ${reactions.length} profile(s) captured.`);
      if (!reactions.length) warnings.push("Reaction dialog opened but no LinkedIn profile URL could be captured through the normal visible UI.");
    } else {
      warnings.push("A reaction-user list trigger was not exposed by the page.");
    }

    const deduped = new Map<string, ScrapedEngagement>();
    for (const item of engagements) {
      const key = item.profileUrl.toLowerCase();
      const existing = deduped.get(key);
      // Keep COMMENT as the primary engagement when the same person also reacted.
      if (!existing || (existing.type === "REACTION" && item.type === "COMMENT") || (!existing.headline && item.headline)) {
        deduped.set(key, item);
      }
    }

    return { engagements: [...deduped.values()], warnings };
  } finally {
    await page.close().catch(() => {});
  }
}
