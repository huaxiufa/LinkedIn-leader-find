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
const genericName = (v: string) => /^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business|celebrate|support|love|insightful|funny)$/i.test(clean(v)) || clean(v).length < 2;

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

function postId(postUrl: string) {
  return postUrl.match(/(?:ugcPost-|activity-)(\d+)/i)?.[1] ?? "";
}

async function findPostRoot(page: Page, postUrl: string): Promise<Locator | null> {
  const id = postId(postUrl);
  const selectors: string[] = [];
  if (id) {
    selectors.push(`[data-urn*="${id}"], [data-id*="${id}"]`);
    selectors.push(`[data-urn="urn:li:activity:${id}"], [data-id="urn:li:activity:${id}"]`);
  }
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const n = Math.min(await loc.count().catch(() => 0), 20);
    for (let i = 0; i < n; i++) {
      const candidate = loc.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const article = candidate.locator("xpath=ancestor::article[1]");
      if (await article.count().catch(() => 0)) return article;
      return candidate;
    }
  }
  const normalized = normalizeLinkedInUrl(postUrl).replace(/\/$/, "").toLowerCase();
  const links = page.locator(`a[href*="/posts/"], a[href*="/feed/update/"]`);
  const n = Math.min(await links.count().catch(() => 0), 100);
  for (let i = 0; i < n; i++) {
    const href = normalizeLinkedInUrl((await links.nth(i).getAttribute("href").catch(() => "")) || "").replace(/\/$/, "").toLowerCase();
    if (href && (href === normalized || href.includes(id))) {
      const article = links.nth(i).locator("xpath=ancestor::article[1]");
      if (await article.count().catch(() => 0)) return article;
    }
  }
  const articles = page.locator("article");
  const ac = Math.min(await articles.count().catch(() => 0), 50);
  let best: Locator | null = null;
  let bestScore = 0;
  for (let i = 0; i < ac; i++) {
    const a = articles.nth(i);
    if (!(await a.isVisible().catch(() => false))) continue;
    const text = clean(await a.innerText().catch(() => ""));
    let score = 0;
    if (id && text.includes(id)) score += 3;
    if (/\bcomments?\b/i.test(text)) score++;
    if (/\breactions?\b|\blikes?\b/i.test(text)) score++;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  if (best) console.log(`Post root fallback selected with score=${bestScore}.`);
  return best;
}

async function diagnosticControls(root: Locator) {
  const controls = root.locator("button, [role='button'], a");
  const n = Math.min(await controls.count().catch(() => 0), 120);
  const hits: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const label = clean((await c.getAttribute("aria-label").catch(() => "")) || (await c.getAttribute("title").catch(() => "")) || (await c.innerText().catch(() => "")));
    if (/comment|reaction|like/i.test(label)) hits.push(label.slice(0, 120));
  }
  if (hits.length) console.log(`Post interaction controls: ${hits.slice(0, 20).join(" | ")}`);
}

async function findPostControl(page: Page, kind: "comments" | "reactions", postUrl: string) {
  const root = await findPostRoot(page, postUrl);
  if (!root) { console.log(`Could not identify post root for ${kind}.`); return null; }
  await diagnosticControls(root);
  const countPattern = kind === "comments" ? /^\d[\d,.]*\s+comments?$/i : /^\d[\d,.]*\s+(?:reactions?|likes?)$/i;
  const labelPattern = kind === "comments" ? /comment/i : /reaction|like/i;
  const candidates = root.locator("button, [role='button'], a, [tabindex='0']");
  const n = Math.min(await candidates.count().catch(() => 0), 200);
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const text = clean(await c.innerText().catch(() => ""));
    const aria = clean(await c.getAttribute("aria-label").catch(() => ""));
    const title = clean(await c.getAttribute("title").catch(() => ""));
    const data = clean(await c.getAttribute("data-view-name").catch(() => ""));
    const combined = `${text} ${aria} ${title} ${data}`;
    if (countPattern.test(text) || countPattern.test(aria) || countPattern.test(title)) return c;
    if (labelPattern.test(combined) && !/reply|follow|my network|notification|messaging/i.test(combined)) return c;
  }
  console.log(`No ${kind} control found inside identified post root.`);
  return null;
}

async function openComments(page: Page, postUrl: string) {
  const trigger = await findPostControl(page, "comments", postUrl);
  if (!trigger) return false;
  console.log("Comment interaction control found; clicking it.");
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
  await page.waitForTimeout(1000);
  return true;
}

const commentContainers = [
  '[class*="comments-comment-item"]',
  '[data-view-name*="comment"]',
  '[data-test-id*="comment"]',
  '[data-testid*="comment"]',
  '[data-id*="comment"]',
  '[data-urn*="comment"]',
  'li[class*="comment"]'
].join(', ');

const commentTextSelectors = [
  '[class*="comment-item__main-content"]',
  '[class*="comment-item__inline-show-more-text"]',
  '[class*="comment-item__comment-text"]',
  '[class*="comment-text"]',
  '[data-view-name*="comment"] [dir="auto"]'
].join(', ');

async function expandComments(page: Page) {
  for (let round = 0; round < 12; round++) {
    const buttons = page.locator("button, [role='button']");
    const n = Math.min(await buttons.count().catch(() => 0), 200);
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const label = clean((await b.getAttribute("aria-label").catch(() => "")) || (await b.innerText().catch(() => "")));
      if (/load more comments|show more comments|view more comments|previous comments|more comments/i.test(label)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
}

function nearestStrongComment(anchor: Locator) {
  return anchor.locator(`xpath=ancestor::*[${[
    'contains(@class,"comments-comment-item")',
    'contains(@class,"comment-item")',
    'contains(@data-urn,"comment")',
    'contains(@data-id,"comment")',
    'contains(@data-test-id,"comment")',
    'contains(@data-testid,"comment")'
  ].join(" or ")}][1]`);
}

async function commentText(container: Locator, name: string) {
  const bodies = container.locator(commentTextSelectors);
  for (let i = 0, n = Math.min(await bodies.count().catch(() => 0), 20); i < n; i++) {
    const text = clean(await bodies.nth(i).innerText().catch(() => ""));
    if (text && text.toLowerCase() !== name.toLowerCase() && !/^(like|reply|follow|edited|see more|see less|translate)$/i.test(text)) return text.slice(0, 5000);
  }
  const lines = (await container.innerText().catch(() => "")).split(/\n+/).map(clean).filter(Boolean);
  const idx = lines.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  if (idx >= 0) {
    const candidates = lines.slice(idx + 1).filter((x) => x.length > 1 && !/^(like|reply|follow|edited|see more|see less|translate|see translation)$/i.test(x));
    if (candidates.length) return candidates.join(" ").slice(0, 5000);
  }
  return "";
}

function commentSurface(page: Page) {
  return page.locator('[role="dialog"], [role="tabpanel"], .artdeco-modal, [data-test-modal], [data-test-dialog]').filter({ hasText: /comment|reply/i }).last();
}

async function collectComments(page: Page, max: number, postUrl: string) {
  const seen = new Set<string>();
  const out: ScrapedEngagement[] = [];
  const opened = await openComments(page, postUrl);
  if (!opened) console.log("Comment control was not found; checking strongly-marked comment containers already in the DOM.");
  await expandComments(page);
  const surface = commentSurface(page);
  const scope = await surface.count().catch(() => 0) ? surface : page.locator(await findPostRoot(page, postUrl) ?? "article").first();
  const containers = scope.locator(commentContainers);
  const n = Math.min(await containers.count().catch(() => 0), Math.max(max * 5, 200));
  let anchorsFound = 0;
  for (let i = 0; i < n && out.length < max; i++) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;
    const text = clean(await container.innerText().catch(() => ""));
    if (!/\breply\b/i.test(text)) continue;
    const anchors = container.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const an = Math.min(await anchors.count().catch(() => 0), 8);
    anchorsFound += an;
    for (let j = 0; j < an && out.length < max; j++) {
      const a = anchors.nth(j);
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || genericName(name) || seen.has(href.toLowerCase())) continue;
      const body = await commentText(container, name);
      if (!body) continue;
      seen.add(href.toLowerCase());
      out.push({ profileUrl: href, name, type: "COMMENT", commentText: body });
    }
  }
  // Strict fallback: page-wide anchors are allowed only if their nearest ancestor
  // has an explicit comment marker. This prevents unrelated people on the page
  // from becoming fake commenters.
  if (out.length < max) {
    const anchors = page.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const an = Math.min(await anchors.count().catch(() => 0), max * 12);
    let fallback = 0;
    for (let i = 0; i < an && out.length < max; i++) {
      const a = anchors.nth(i);
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || genericName(name) || seen.has(href.toLowerCase())) continue;
      const candidate = nearestStrongComment(a);
      if (!(await candidate.count().catch(() => 0))) continue;
      const candidateText = clean(await candidate.innerText().catch(() => ""));
      if (!/\breply\b/i.test(candidateText)) continue;
      const body = await commentText(candidate, name);
      if (!body) continue;
      fallback++;
      seen.add(href.toLowerCase());
      out.push({ profileUrl: href, name, type: "COMMENT", commentText: body });
    }
    console.log(`Comment diagnostics: containers=${n}, profileAnchors=${anchorsFound}, strictFallback=${fallback}`);
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
  if (!trigger) { warnings.push("Could not locate the reaction interaction control inside the LinkedIn post."); return out; }
  console.log("Reaction interaction control found; clicking it.");
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
  await page.waitForTimeout(1000);
  for (let round = 0; round < 50 && out.length < max; round++) {
    const surface = reactionSurface(page);
    if (!(await surface.count().catch(() => 0))) {
      if (round === 0) console.log("Reaction surface not detected after click; no page-wide profile fallback will be used.");
      break;
    }
    const anchors = surface.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
    const n = Math.min(await anchors.count().catch(() => 0), 1000);
    for (let i = 0; i < n && out.length < max; i++) {
      const a = anchors.nth(i);
      if (!(await a.isVisible().catch(() => false))) continue;
      const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
      const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
      if (!href || !name || genericName(name) || seen.has(href.toLowerCase())) continue;
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
    await page.waitForTimeout(1800);
    const signedOut = await page.locator('input[name="session_key"], form[action*="login"]').count().catch(() => 0);
    console.log(`LinkedIn session: ${signedOut ? "SIGNED OUT" : "SIGNED IN"}`);
    if (signedOut) warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");
    const comments = await collectComments(page, maxComments, postUrl);
    const reactions = await collectReactions(page, maxReactions, warnings, postUrl);
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
