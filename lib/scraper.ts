import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
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
  const version = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
  console.log(`Chrome CDP browser: ${version.Browser ?? "unknown"}`);
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 30000 });
  const context = browser.contexts()[0];
  if (!context) {
    browser.disconnect();
    throw new Error("Chrome CDP connected, but no browser context is available.");
  }
  const page = await context.newPage();
  console.log("Created dedicated LinkedIn scraping tab; existing Chrome tabs remain untouched.");
  return { browser, context, page };
}

function profileRow(anchor: Locator) {
  return anchor.locator("xpath=ancestor::*[self::li or @role='listitem' or self::article][1]");
}

async function collectProfileLinks(scope: Locator, seen: Set<string>, type: "COMMENT" | "REACTION", limit: number) {
  const anchors = scope.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]');
  const count = Math.min(await anchors.count().catch(() => 0), 3000);
  const result: ScrapedEngagement[] = [];
  for (let i = 0; i < count && result.length < limit; i++) {
    const anchor = anchors.nth(i);
    const href = normalizeLinkedInUrl((await anchor.getAttribute("href").catch(() => "")) || (await anchor.getAttribute("data-test-profile-url").catch(() => "")) || (await anchor.getAttribute("data-profile-url").catch(() => "")) || "");
    if (!isProfileUrl(href) || seen.has(href.toLowerCase())) continue;
    const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
    const row = profileRow(anchor);
    const rowText = clean(await row.textContent().catch(() => ""));
    const headline = name && rowText.startsWith(name) ? clean(rowText.slice(name.length)) : "";
    seen.add(href.toLowerCase());
    result.push({ profileUrl: href, name: name || href.split("/in/")[1]?.replace(/\/?$/, "") || "LinkedIn member", headline: headline || undefined, jobTitle: headline || undefined, type, reactionType: type === "REACTION" ? "UNKNOWN" : undefined, commentText: type === "COMMENT" ? rowText.slice(0, 5000) : undefined });
  }
  return result;
}

function reactionDialog(page: Page) {
  const dialogs = page.locator('[role="dialog"], [role="listbox"], [role="menu"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]');
  return dialogs.filter({ hasText: /people who reacted|reactions?|likes?/i }).last();
}

async function reactionSurfaceSnapshot(page: Page) {
  const surfaces = page.locator('[role="dialog"], [role="listbox"], [role="menu"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]');
  const count = await surfaces.count().catch(() => 0);
  const visibleMatches: Array<{ index: number; links: number; text: string }> = [];
  let best: Locator | null = null;
  let bestScore = -1;
  let bestText = "";
  for (let i = 0; i < count; i++) {
    const candidate = surfaces.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = clean(await candidate.innerText().catch(() => ""));
    const links = await candidate.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]').count().catch(() => 0);
    const reactionWords = (text.match(/people who reacted|reactions?|likes?/gi) || []).length;
    visibleMatches.push({ index: i, links, text: text.slice(0, 600) });
    const score = links * 100000 + reactionWords * 1000 + text.length;
    if (score > bestScore) { bestScore = score; best = candidate; bestText = text; }
  }
  if (!best) return { url: page.url(), surfaceCount: count, visibleMatches, text: "", links: [], profileLinksOnPage: await page.locator('a[href*="/in/"]').count().catch(() => 0), bodyReactionContext: clean(await page.locator("body").innerText().catch(() => "")).slice(0, 1500) };
  const linksLocator = best.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]');
  const linkCount = Math.min(await linksLocator.count().catch(() => 0), 80);
  const links: Array<{ href: string; text: string; aria: string }> = [];
  for (let i = 0; i < linkCount; i++) {
    const link = linksLocator.nth(i);
    links.push({ href: normalizeLinkedInUrl(await link.getAttribute("href").catch(() => "") || ""), text: clean(await link.textContent().catch(() => "")), aria: clean(await link.getAttribute("aria-label").catch(() => "")) });
  }
  return { url: page.url(), surfaceCount: count, visibleMatches, text: bestText.slice(0, 5000), links, profileLinksOnPage: await page.locator('a[href*="/in/"]').count().catch(() => 0), selectedProfileLinks: linkCount, bodyReactionContext: clean(await page.locator("body").innerText().catch(() => "")).slice(0, 1500) };
}

async function closeTransientProfile(page: Page) {
  const buttons = page.getByRole("button", { name: /close/i });
  const count = await buttons.count().catch(() => 0);
  if (count) await buttons.last().click({ timeout: 1200 }).catch(() => {});
}

async function scrollReactionDialog(dialog: Locator, page: Page) {
  if (await dialog.count().catch(() => 0) === 0) return false;
  const beforeText = clean(await dialog.innerText().catch(() => ""));
  await dialog.focus().catch(() => {});
  await dialog.press("PageDown").catch(() => {});
  await page.waitForTimeout(300);
  const afterText = clean(await dialog.innerText().catch(() => ""));
  if (afterText !== beforeText) return true;
  const box = await dialog.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, Math.max(500, box.height * 0.9));
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function captureReactionCandidates(dialog: Locator, page: Page, seen: Set<string>, max: number) {
  const results: ScrapedEngagement[] = [];
  const candidates = dialog.locator('a, [role="link"], button, [role="button"], [tabindex="0"], [data-control-name], [data-view-name], [data-test-id], span[dir="ltr"], span.hoverable-link-text, [class*="hoverable-link-text"]');
  const count = Math.min(await candidates.count().catch(() => 0), 4000);
  const visitedLabels = new Set<string>();
  for (let i = 0; i < count && results.length < max; i++) {
    const candidate = candidates.nth(i);
    const label = clean((await candidate.textContent().catch(() => "")) || (await candidate.getAttribute("aria-label").catch(() => "")) || (await candidate.getAttribute("title").catch(() => "")));
    const href = normalizeLinkedInUrl((await candidate.getAttribute("href").catch(() => "")) || (await candidate.getAttribute("data-href").catch(() => "")) || (await candidate.getAttribute("data-profile-url").catch(() => "")) || (await candidate.getAttribute("data-test-profile-url").catch(() => "")) || "");
    if (!label || label.length < 2 || label.length > 140 || visitedLabels.has(label)) continue;
    if (/^(like|comment|share|send|follow|connect|message|more|close|back|next|previous|sort|filter|search|reactions?|see all|people who reacted|button|link|tab|menuitem|listitem|all|celebrate|support|love|insightful|funny)$/i.test(label)) continue;
    visitedLabels.add(label);
    if (isProfileUrl(href) && !seen.has(href.toLowerCase())) {
      seen.add(href.toLowerCase());
      results.push({ profileUrl: href, name: label, type: "REACTION", reactionType: "UNKNOWN" });
      continue;
    }
    const beforePages = page.context().pages();
    const beforeUrl = page.url();
    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      const popupPromise = page.waitForEvent("popup", { timeout: 700 }).catch(() => undefined);
      await candidate.click({ timeout: 1800, force: false }).catch(async () => candidate.click({ timeout: 1000, force: true }));
      const popup = await popupPromise;
      await page.waitForTimeout(600);
      const pagesNow = page.context().pages();
      const newPage = pagesNow.find(p => !beforePages.includes(p) && !p.isClosed());
      const target = popup && !popup.isClosed() ? popup : (newPage ?? page);
      const targetUrl = normalizeLinkedInUrl(target.url());
      if (isProfileUrl(targetUrl) && !seen.has(targetUrl.toLowerCase())) {
        seen.add(targetUrl.toLowerCase());
        results.push({ profileUrl: targetUrl, name: label, type: "REACTION", reactionType: "UNKNOWN" });
        console.log(`Captured reaction profile URL by click: ${targetUrl}`);
      } else {
        const found = await collectProfileLinks(target.locator("body"), seen, "REACTION", max - results.length);
        results.push(...found);
      }
      if (popup && !popup.isClosed()) await popup.close().catch(() => {});
      if (newPage && !newPage.isClosed()) await newPage.close().catch(() => {});
      if (target === page && page.url() !== beforeUrl && !isProfileUrl(page.url())) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 9000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      await closeTransientProfile(page);
    } catch { }
  }
  return results;
}

async function collectReactionPeople(page: Page, max: number, warnings: string[]) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];
  for (let round = 0; round < 60 && results.length < max; round++) {
    const snapshot = await reactionSurfaceSnapshot(page);
    let dialog = reactionDialog(page);
    if (snapshot.visibleMatches.length) {
      const best = [...snapshot.visibleMatches].sort((a, b) => b.links - a.links || b.text.length - a.text.length)[0];
      dialog = page.locator('[role="dialog"], [role="listbox"], [role="menu"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]').nth(best.index);
    }
    if (await dialog.count().catch(() => 0) === 0) break;
    const direct = await collectProfileLinks(dialog, seen, "REACTION", max - results.length);
    results.push(...direct);
    if (results.length >= max) break;
    if (round === 0) console.log("Reaction surface snapshot:", JSON.stringify(snapshot));
    const clickedResults = await captureReactionCandidates(dialog, page, seen, max - results.length);
    results.push(...clickedResults);
    if (results.length >= max) break;
    const scrolled = await scrollReactionDialog(dialog, page);
    if (!scrolled && clickedResults.length === 0) break;
    await page.waitForTimeout(600);
    if (!scrolled && round > 2) break;
  }
  if (!results.length) {
    const snapshot = await reactionSurfaceSnapshot(page);
    warnings.push(`Reaction extraction found no profile URLs. Diagnostic: surfaces=${snapshot.surfaceCount}, visibleReactionSurfaces=${snapshot.visibleMatches.length}, pageProfileLinks=${snapshot.profileLinksOnPage}, bodyReactionContext=${clean(snapshot.bodyReactionContext).slice(0, 600)}`);
  }
  return results;
}

async function collectComments(page: Page, max: number) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];
  const anchors = page.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]');
  const count = Math.min(await anchors.count().catch(() => 0), max * 5);
  for (let i = 0; i < count && results.length < max; i++) {
    const anchor = anchors.nth(i);
    const href = normalizeLinkedInUrl((await anchor.getAttribute("href").catch(() => "")) || (await anchor.getAttribute("data-test-profile-url").catch(() => "")) || (await anchor.getAttribute("data-profile-url").catch(() => "")) || "");
    if (!isProfileUrl(href) || seen.has(href.toLowerCase())) continue;
    const row = profileRow(anchor);
    const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
    const rowText = clean(await row.textContent().catch(() => ""));
    if (!name) continue;
    const headline = rowText.startsWith(name) ? clean(rowText.slice(name.length)) : "";
    seen.add(href.toLowerCase());
    results.push({ profileUrl: href, name, headline: headline || undefined, jobTitle: headline || undefined, type: "COMMENT", commentText: rowText.slice(0, 5000) });
  }
  return results;
}

export async function scrapePublicPost(postUrl: string, options: { maxComments?: number; maxReactions?: number } = {}): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];
  const { browser, page } = await connectToLinkedInBrowser();
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const bodyText = clean(await page.locator("body").textContent().catch(() => ""));
    if (/sign in|join linkedin|log in/i.test(bodyText)) warnings.push("The connected Windows Chrome session appears to be signed out of LinkedIn. Log into LinkedIn in that Chrome window and retry.");
    console.log(/sign in|join linkedin|log in/i.test(bodyText) ? "LinkedIn session: SIGNED OUT" : "LinkedIn session: SIGNED IN");
    const comments = await collectComments(page, maxComments);
    engagements.push(...comments);
    console.log(`Comment extraction: ${comments.length} profile(s) captured.`);
    const triggers = page.getByRole("button", { name: /people who reacted|reactions|reaction(s)?\s*\d+/i });
    let triggerCount = await triggers.count().catch(() => 0);
    if (triggerCount) await triggers.first().click().catch(() => {});
    else {
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
    } else warnings.push("A reaction-user list trigger was not exposed by the page.");
    const deduped = new Map<string, ScrapedEngagement>();
    for (const item of engagements) {
      const key = normalizeLinkedInUrl(item.profileUrl).toLowerCase();
      if (!key) continue;
      const existing = deduped.get(key);
      if (!existing || (existing.type === "REACTION" && item.type === "COMMENT")) deduped.set(key, item);
    }
    return { engagements: [...deduped.values()], warnings };
  } finally {
    await page.close().catch(() => {});
    // Disconnect Playwright from the existing Windows Chrome instance without closing Chrome.
    // Keeping the CDP connection open across jobs can eventually make a fresh connectOverCDP
    // hang after the WebSocket connects. The dedicated scraping tab is closed above; Chrome stays open.
    browser.disconnect();
  }
}
