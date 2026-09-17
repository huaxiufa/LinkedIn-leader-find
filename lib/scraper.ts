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

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const profile = (v: string) => { const u = normalizeLinkedInUrl(v); return /linkedin\.com\/in\//i.test(u) ? u : ""; };

async function connectBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const configured = new URL(process.env.LINKEDIN_CDP_URL ?? "http://host.docker.internal:9222");
  let host = configured.hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host !== "localhost") {
    const addresses = await lookup(host, { all: true });
    const ipv4 = addresses.find((x) => x.family === 4);
    if (!ipv4) throw new Error(`Could not resolve ${host} to IPv4.`);
    host = ipv4.address;
  }
  const endpoint = `http://${host}:${configured.port || "9222"}`;
  const response = await fetch(`${endpoint}/json/version`, { headers: { Host: host } });
  if (!response.ok) throw new Error(`Chrome CDP endpoint returned HTTP ${response.status}.`);
  const version = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
  console.log(`Chrome CDP browser: ${version.Browser ?? "unknown"}`);
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 30000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connected, but no browser context is available.");
  const page = await context.newPage();
  console.log("Created dedicated LinkedIn scraping tab; existing Chrome tabs remain untouched.");
  return { browser, context, page };
}

const postRoots = (page: Page) => page.locator('article, [data-urn*="ugcPost"], [data-urn*="activity"], [data-id*="ugcPost"], [data-id*="urn:li:activity"]');

async function findPostControl(page: Page, kind: "comments" | "reactions", postUrl: string) {
  const id = postUrl.match(/(?:ugcPost-|activity-)(\d+)/i)?.[1] ?? "";
  const roots: Locator[] = [];
  if (id) roots.push(page.locator(`[data-urn*="${id}"], [data-id*="${id}"]`).first());
  const rootsAll = postRoots(page);
  const count = Math.min(await rootsAll.count().catch(() => 0), 30);
  for (let i = 0; i < count; i++) roots.push(rootsAll.nth(i));
  const exact = kind === "comments" ? /^\d+\s+comments?$/i : /^\d+\s+(?:reactions?|likes?)$/i;
  for (const root of roots) {
    if (!(await root.count().catch(() => 0)) || !(await root.isVisible().catch(() => false))) continue;
    const node = root.getByText(exact).first();
    if (!(await node.count().catch(() => 0)) || !(await node.isVisible().catch(() => false))) continue;
    const clickable = node.locator("xpath=ancestor::*[self::button or @role='button' or self::a or @tabindex='0'][1]");
    return (await clickable.count().catch(() => 0)) ? clickable : node;
  }
  return null;
}

async function openComments(page: Page, postUrl: string) {
  const trigger = await findPostControl(page, "comments", postUrl);
  if (!trigger) return false;
  console.log("Comment count control found; clicking the post's comment count.");
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
  await page.waitForTimeout(1000);
  return true;
}

const commentContainers = [
  '.comments-comment-item',
  '[class*="comments-comment-item"]',
  '[class*="comments-comment"]',
  '[data-view-name*="comment"]',
  '[data-test-id*="comment"]',
  '[data-testid*="comment"]',
  '[data-id*="comment"]',
  '[data-urn*="comment"]',
  'li[class*="comment"]'
].join(', ');

const commentTextSelectors = [
  '.comments-comment-item__main-content',
  '.comments-comment-item__inline-show-more-text',
  '.comments-comment-item__comment-text',
  '.comments-comment-item__text-wrapper',
  '[class*="comment-item__main-content"]',
  '[class*="comment-item__inline-show-more-text"]',
  '[class*="comment-text"]',
  '[data-view-name*="comment"] [dir="auto"]'
].join(', ');

async function expandComments(page: Page) {
  for (let round = 0; round < 10; round++) {
    const buttons = page.getByRole("button", { name: /load more comments|show more comments|view more comments|previous comments/i });
    const n = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); clicked = true; break; }
    }
    if (!clicked) break;
  }
}

function nearestComment(anchor: Locator) {
  return anchor.locator(`xpath=ancestor::*[${[
    'contains(@class,"comments-comment-item")',
    'contains(@class,"comments-comment")',
    'contains(@class,"comment-item")',
    'contains(@data-id,"comment")',
    'contains(@data-urn,"comment")',
    'contains(@data-test-id,"comment")',
    'contains(@data-testid,"comment")'
  ].join(" or ")}][1]`);
}

async function commentText(container: Locator, name: string) {
  const bodies = container.locator(commentTextSelectors);
  for (let i = 0, n = Math.min(await bodies.count().catch(() => 0), 20); i < n; i++) {
    const text = clean(await bodies.nth(i).innerText().catch(() => ""));
    if (text && text.toLowerCase() !== name.toLowerCase()) return text.slice(0, 5000);
  }
  const lines = (await container.innerText().catch(() => "")).split(/\n+/).map(clean).filter(Boolean);
  const idx = lines.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  if (idx >= 0) {
    const candidates = lines.slice(idx + 1).filter((x) => x.length > 1 && !/^(like|reply|follow|edited|see more|see less|translate|see translation)$/i.test(x));
    if (candidates.length) return candidates.join(" ").slice(0, 5000);
  }
  return "";
}

async function collectComments(page: Page, max: number) {
  const seen = new Set<string>();
  const out: ScrapedEngagement[] = [];
  const opened = await openComments(page, page.url());
  if (!opened) console.log("Comment count control was not found; checking already-visible comment containers.");
  await expandComments(page);

  const containers = page.locator(commentContainers);
  const n = Math.min(await containers.count().catch(() => 0), Math.max(max * 5, 200));
  let profileAnchors = 0;
  for (let i = 0; i < n && out.length < max; i++) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;
    const text = clean(await container.innerText().catch(() => ""));
    if (!/\breply\b/i.test(text)) continue;
    const anchors = container.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const an = Math.min(await anchors.count().catch(() => 0), 5);
    profileAnchors += an;
    for (let j = 0; j < an && out.length < max; j++) {
      const a = anchors.nth(j);
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || seen.has(href.toLowerCase())) continue;
      const textValue = await commentText(container, name);
      if (!textValue) continue;
      seen.add(href.toLowerCase());
      out.push({ profileUrl: href, name, type: "COMMENT", commentText: textValue });
      break;
    }
  }

  // Layout fallback: only accept a profile when its nearest comment-like ancestor
  // explicitly contains Reply and real comment text. Never use page-wide /in/ links.
  if (out.length < max) {
    const anchors = page.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const an = Math.min(await anchors.count().catch(() => 0), max * 10);
    let fallbackCandidates = 0;
    for (let i = 0; i < an && out.length < max; i++) {
      const a = anchors.nth(i);
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || seen.has(href.toLowerCase())) continue;
      const candidate = nearestComment(a);
      if (!(await candidate.count().catch(() => 0))) continue;
      const candidateText = clean(await candidate.innerText().catch(() => ""));
      if (!/\breply\b/i.test(candidateText)) continue;
      fallbackCandidates++;
      const textValue = await commentText(candidate, name);
      if (!textValue) continue;
      seen.add(href.toLowerCase());
      out.push({ profileUrl: href, name, type: "COMMENT", commentText: textValue });
    }
    console.log(`Comment diagnostics: containers=${n}, profileAnchors=${profileAnchors}, fallbackCandidates=${fallbackCandidates}`);
  }
  console.log(`Comment container extraction: ${out.length} real comment(s) captured.`);
  return out;
}

function reactionSurface(page: Page) {
  return page.locator('[role="dialog"], [role="listbox"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]').filter({ hasText: /people who reacted|\breactions?\b|\blikes?\b/i }).last();
}

async function collectReactions(page: Page, max: number, warnings: string[], postUrl: string) {
  const out: ScrapedEngagement[] = [];
  const seen = new Set<string>();
  const trigger = await findPostControl(page, "reactions", postUrl);
  if (!trigger) { warnings.push("Could not locate the reaction count control inside the LinkedIn post."); return out; }
  console.log("Reaction control found; clicking the post's reaction count.");
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
  await page.waitForTimeout(1000);
  for (let round = 0; round < 40 && out.length < max; round++) {
    const surface = reactionSurface(page);
    if (!(await surface.count().catch(() => 0))) break;
    const anchors = surface.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const n = Math.min(await anchors.count().catch(() => 0), 1000);
    for (let i = 0; i < n && out.length < max; i++) {
      const a = anchors.nth(i);
      if (!(await a.isVisible().catch(() => false))) continue;
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || seen.has(href.toLowerCase()) || /^(reactions?|likes?|people who reacted|close|all)$/i.test(name)) continue;
      seen.add(href.toLowerCase());
      out.push({ profileUrl: href, name, type: "REACTION", reactionType: "UNKNOWN" });
    }
    if (out.length >= max) break;
    const before = clean(await surface.innerText().catch(() => ""));
    await surface.focus().catch(() => {});
    await surface.press("PageDown").catch(() => {});
    await page.waitForTimeout(450);
    const after = clean(await surface.innerText().catch(() => ""));
    if (after === before) break;
  }
  if (!out.length) warnings.push("Reaction list opened, but no public LinkedIn profile URLs were exposed inside the reaction surface.");
  console.log(`Reaction extraction: ${out.length} profile(s) captured.`);
  return out;
}

export async function scrapePublicPost(postUrl: string, options: { maxComments?: number; maxReactions?: number } = {}): Promise<ScrapeResult> {
  const maxComments = options.maxComments ?? 500;
  const maxReactions = options.maxReactions ?? 500;
  const warnings: string[] = [];
  const { browser, page } = await connectBrowser();
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const signedOut = await page.locator('input[name="session_key"], form[action*="login"]').count().catch(() => 0);
    console.log(`LinkedIn session: ${signedOut ? "SIGNED OUT" : "SIGNED IN"}`);
    if (signedOut) warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");

    const comments = await collectComments(page, maxComments);
    const reactions = await collectReactions(page, maxReactions, warnings, postUrl);

    // Dedupe within this post. If somebody both commented and reacted, the
    // comment is the primary engagement and retains its comment text.
    const merged = new Map<string, ScrapedEngagement>();
    for (const item of [...reactions, ...comments]) {
      const key = normalizeLinkedInUrl(item.profileUrl).toLowerCase();
      if (!key) continue;
      const existing = merged.get(key);
      if (!existing || item.type === "COMMENT") merged.set(key, item);
    }
    console.log(`Engagement merge: comments=${comments.length}, reactions=${reactions.length}, unique=${merged.size}.`);
    return { engagements: [...merged.values()], warnings };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}
