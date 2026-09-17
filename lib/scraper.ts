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
  if (!context) { browser.disconnect(); throw new Error("Chrome CDP connected, but no browser context is available."); }
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

const surfaceSelector = '[role="dialog"], [role="listbox"], [role="menu"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]';

function reactionDialog(page: Page) {
  const surfaces = page.locator(surfaceSelector);
  return surfaces.filter({ hasText: /people who reacted|reactions?|likes?/i }).last();
}

async function reactionSurfaceSnapshot(page: Page) {
  const surfaces = page.locator(surfaceSelector);
  const count = await surfaces.count().catch(() => 0);
  const visibleMatches: Array<{ index: number; links: number; text: string }> = [];
  for (let i = 0; i < count; i++) {
    const candidate = surfaces.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = clean(await candidate.innerText().catch(() => ""));
    const links = await candidate.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]').count().catch(() => 0);
    visibleMatches.push({ index: i, links, text: text.slice(0, 600) });
  }
  return { url: page.url(), surfaceCount: count, visibleMatches, profileLinksOnPage: await page.locator('a[href*="/in/"]').count().catch(() => 0), bodyReactionContext: clean(await page.locator("body").innerText().catch(() => "")).slice(0, 1800) };
}

async function scrollReactionDialog(dialog: Locator, page: Page) {
  if (await dialog.count().catch(() => 0) === 0) return false;
  const before = clean(await dialog.innerText().catch(() => ""));
  await dialog.focus().catch(() => {});
  await dialog.press("PageDown").catch(() => {});
  await page.waitForTimeout(350);
  const after = clean(await dialog.innerText().catch(() => ""));
  if (after !== before) return true;
  const box = await dialog.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, Math.max(500, box.height * 0.9));
    await page.waitForTimeout(350);
    return true;
  }
  return false;
}

async function findReactionTrigger(page: Page) {
  const postCandidates = page.locator('article, [data-urn*="activity"], [data-id*="urn:li:activity"], [data-urn*="ugcPost"], [data-id*="ugcPost"]');
  const postCount = Math.min(await postCandidates.count().catch(() => 0), 30);
  for (let i = 0; i < postCount; i++) {
    const post = postCandidates.nth(i);
    if (!(await post.isVisible().catch(() => false))) continue;
    const text = clean(await post.innerText().catch(() => ""));
    if (!/\breactions?\b/i.test(text)) continue;
    const controls = post.locator('button, [role="button"], a');
    const controlCount = Math.min(await controls.count().catch(() => 0), 300);
    for (let j = 0; j < controlCount; j++) {
      const c = controls.nth(j);
      const label = clean((await c.innerText().catch(() => "")) || (await c.getAttribute("aria-label").catch(() => "")) || (await c.getAttribute("title").catch(() => "")));
      if (/\b\d+\s+reactions?\b/i.test(label) || /\breactions?\b/i.test(label) && !/like|comment|share|send/i.test(label)) return c;
    }
  }
  const controls = page.locator('button, [role="button"], a');
  const count = Math.min(await controls.count().catch(() => 0), 2000);
  for (let i = 0; i < count; i++) {
    const c = controls.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const label = clean((await c.innerText().catch(() => "")) || (await c.getAttribute("aria-label").catch(() => "")) || (await c.getAttribute("title").catch(() => "")));
    if (!/^\d+\s+reactions?$/i.test(label) && !/^\d+\s+likes?$/i.test(label)) continue;
    const nearby = clean(await c.locator("xpath=..").innerText().catch(() => ""));
    if (/my network|connections|grow your network|notifications|messaging/i.test(nearby)) continue;
    return c;
  }
  return null;
}

async function captureReactionCandidates(dialog: Locator, page: Page, seen: Set<string>, max: number) {
  const results: ScrapedEngagement[] = [];
  const direct = await collectProfileLinks(dialog, seen, "REACTION", max);
  results.push(...direct);
  if (results.length >= max) return results;
  const candidates = dialog.locator('a, [role="link"], button, [role="button"], [tabindex="0"], [data-control-name], [data-view-name], span.hoverable-link-text, [class*="hoverable-link-text"]');
  const count = Math.min(await candidates.count().catch(() => 0), 3000);
  const visitedLabels = new Set<string>();
  for (let i = 0; i < count && results.length < max; i++) {
    const candidate = candidates.nth(i);
    const label = clean((await candidate.textContent().catch(() => "")) || (await candidate.getAttribute("aria-label").catch(() => "")) || (await candidate.getAttribute("title").catch(() => "")));
    if (!label || label.length < 2 || label.length > 140 || visitedLabels.has(label)) continue;
    if (/^(like|comment|share|send|follow|connect|message|more|close|back|next|previous|sort|filter|search|reactions?|see all|people who reacted|button|link|tab|menuitem|listitem|all|celebrate|support|love|insightful|funny)$/i.test(label)) continue;
    visitedLabels.add(label);
    const href = normalizeLinkedInUrl((await candidate.getAttribute("href").catch(() => "")) || (await candidate.getAttribute("data-href").catch(() => "")) || (await candidate.getAttribute("data-profile-url").catch(() => "")) || (await candidate.getAttribute("data-test-profile-url").catch(() => "")) || "");
    if (isProfileUrl(href) && !seen.has(href.toLowerCase())) {
      seen.add(href.toLowerCase());
      results.push({ profileUrl: href, name: label, type: "REACTION", reactionType: "UNKNOWN" });
    }
  }
  return results;
}

async function collectReactionPeople(page: Page, max: number, warnings: string[]) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];
  const beforeUrl = page.url();
  const trigger = await findReactionTrigger(page);
  if (!trigger) {
    warnings.push("Could not locate the reaction count control inside the LinkedIn post. The scraper did not click My Network or other navigation UI.");
    return results;
  }
  console.log("Reaction trigger found; clicking the post's reaction count control.");
  await trigger.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 3000, force: true }));
  await page.waitForTimeout(900);
  for (let round = 0; round < 60 && results.length < max; round++) {
    const dialog = reactionDialog(page);
    const snapshot = await reactionSurfaceSnapshot(page);
    if (round === 0) console.log("Reaction surface snapshot:", JSON.stringify(snapshot));
    if (await dialog.count().catch(() => 0) === 0) {
      if (page.url() !== beforeUrl && !isProfileUrl(page.url())) await page.goBack({ waitUntil: "domcontentloaded", timeout: 9000 }).catch(() => {});
      warnings.push(`Reaction count was clicked, but LinkedIn did not expose a reaction list surface. Diagnostic: surfaces=${snapshot.surfaceCount}, visibleSurfaces=${snapshot.visibleMatches.length}, pageProfileLinks=${snapshot.profileLinksOnPage}`);
      break;
    }
    const found = await captureReactionCandidates(dialog, page, seen, max - results.length);
    results.push(...found);
    if (results.length >= max) break;
    const scrolled = await scrollReactionDialog(dialog, page);
    if (!scrolled) break;
    await page.waitForTimeout(500);
  }
  if (!results.length) {
    const snapshot = await reactionSurfaceSnapshot(page);
    warnings.push(`Reaction extraction found no profile URLs. Diagnostic: surfaces=${snapshot.surfaceCount}, visibleSurfaces=${snapshot.visibleMatches.length}, pageProfileLinks=${snapshot.profileLinksOnPage}, bodyReactionContext=${clean(snapshot.bodyReactionContext).slice(0, 600)}`);
  }
  return results;
}

const commentContainerSelector = [
  '.comments-comment-item',
  '[class*="comments-comment-item"]',
  '[class*="comments-comment"]',
  '[data-view-name*="comment"]',
  '[data-test-id*="comment"]',
  '[data-testid*="comment"]',
  '[data-id*="comment"]',
  '[data-urn*="comment"]',
  'li[class*="comment"]',
  'div[class*="comment"]',
].join(', ');

const commentTextSelector = [
  '.comments-comment-item__main-content',
  '.comments-comment-item__inline-show-more-text',
  '.comments-comment-item__comment-text',
  '.comments-comment-item__text-wrapper',
  '[class*="comment-item__main-content"]',
  '[class*="comment-item__inline-show-more-text"]',
  '[class*="comment-text"]',
  '[data-view-name*="comment"] [dir="auto"]',
].join(', ');

async function expandComments(page: Page) {
  for (let round = 0; round < 8; round++) {
    const buttons = page.getByRole("button", { name: /load more comments|show more comments|view more comments|more comments|previous comments/i });
    const count = await buttons.count().catch(() => 0);
    if (!count) break;
    let clicked = false;
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 2500 }).catch(() => {});
      clicked = true;
      await page.waitForTimeout(600);
      break;
    }
    if (!clicked) break;
  }
}

function commentAncestor(anchor: Locator) {
  return anchor.locator(`xpath=ancestor::*[${[
    'contains(@class,"comments-comment-item")',
    'contains(@class,"comments-comment")',
    'contains(@class,"comment-item")',
    'contains(@class,"comment-text")',
    'contains(@data-id,"comment")',
    'contains(@data-urn,"comment")',
    'contains(@data-test-id,"comment")',
    'contains(@data-testid,"comment")'
  ].join(' or ')}][1]`);
}

async function extractCommentText(container: Locator, name: string) {
  const body = container.locator(commentTextSelector);
  const bodyCount = Math.min(await body.count().catch(() => 0), 20);
  for (let i = 0; i < bodyCount; i++) {
    const text = clean(await body.nth(i).innerText().catch(() => ""));
    if (text && text.length > 1 && text.toLowerCase() !== name.toLowerCase()) return text.slice(0, 5000);
  }

  const lines = (await container.innerText().catch(() => ""))
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);
  const nameIndex = lines.findIndex((line) => line.toLowerCase() === name.toLowerCase());
  if (nameIndex >= 0) {
    const candidates = lines.slice(nameIndex + 1).filter((line) =>
      line.length > 1 &&
      !/^(like|reply|follow|edited|see more|see less|translate|see translation)$/i.test(line)
    );
    if (candidates.length) return candidates.join(" ").slice(0, 5000);
  }
  return "";
}

async function collectComments(page: Page, max: number) {
  const seen = new Set<string>();
  const results: ScrapedEngagement[] = [];
  await expandComments(page);

  const containers = page.locator(commentContainerSelector);
  const containerCount = Math.min(await containers.count().catch(() => 0), Math.max(max * 5, 200));
  for (let i = 0; i < containerCount && results.length < max; i++) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;
    const anchors = container.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]');
    const anchorCount = Math.min(await anchors.count().catch(() => 0), 10);
    for (let j = 0; j < anchorCount && results.length < max; j++) {
      const anchor = anchors.nth(j);
      const href = normalizeLinkedInUrl((await anchor.getAttribute("href").catch(() => "")) || (await anchor.getAttribute("data-test-profile-url").catch(() => "")) || (await anchor.getAttribute("data-profile-url").catch(() => "")) || "");
      if (!isProfileUrl(href) || seen.has(href.toLowerCase())) continue;
      const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
      if (!name) continue;
      const commentText = await extractCommentText(container, name);
      if (!commentText) continue;
      seen.add(href.toLowerCase());
      const containerText = clean(await container.innerText().catch(() => ""));
      const headline = containerText.startsWith(name) ? clean(containerText.slice(name.length)) : "";
      results.push({ profileUrl: href, name, headline: headline || undefined, jobTitle: headline || undefined, type: "COMMENT", commentText });
      break;
    }
  }

  // Fallback: some LinkedIn layouts do not expose the comment item class but do
  // expose a profile link inside a parent whose UI contains Reply and comment text.
  if (results.length < max) {
    const anchors = page.locator('a[href*="/in/"], a[data-test-profile-url], a[data-profile-url]');
    const count = Math.min(await anchors.count().catch(() => 0), max * 10);
    for (let i = 0; i < count && results.length < max; i++) {
      const anchor = anchors.nth(i);
      const href = normalizeLinkedInUrl((await anchor.getAttribute("href").catch(() => "")) || (await anchor.getAttribute("data-test-profile-url").catch(() => "")) || (await anchor.getAttribute("data-profile-url").catch(() => "")) || "");
      if (!isProfileUrl(href) || seen.has(href.toLowerCase())) continue;
      const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
      if (!name) continue;
      const candidate = commentAncestor(anchor);
      if (!(await candidate.count().catch(() => 0))) continue;
      const candidateText = clean(await candidate.innerText().catch(() => ""));
      if (!/\breply\b/i.test(candidateText)) continue;
      const commentText = await extractCommentText(candidate, name);
      if (!commentText) continue;
      seen.add(href.toLowerCase());
      results.push({ profileUrl: href, name, type: "COMMENT", commentText });
    }
  }

  console.log(`Comment container extraction: ${results.length} real comment(s) captured.`);
  return results;
}

export async function scrapePublicPost(postUrl: string, options: { maxComments?: number; maxReactions?: number } = {}): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const maxReactions = options.maxReactions ?? 500;
  const warnings: string[] = [];
  const engagements: ScrapedEngagement[] = [];
  const { browser, page } = await connectToLinkedInBrowser();
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const signedOut = await page.locator('input[name="session_key"], form[action*="login"], a[href*="/login"]').count().catch(() => 0);
    if (signedOut) warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");
    console.log(`LinkedIn session: ${signedOut ? "SIGNED OUT" : "SIGNED IN"}`);
    const comments = await collectComments(page, maxComments);
    engagements.push(...comments);
    console.log(`Comment extraction: ${comments.length} profile(s) captured.`);
    const reactions = await collectReactionPeople(page, maxReactions, warnings);
    engagements.push(...reactions);
    console.log(`Reaction extraction: ${reactions.length} profile(s) captured.`);
    return { engagements, warnings };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}
