import { chromium, type Locator, type Page } from "playwright";
import { lookup } from "node:dns/promises";
import { normalizeLinkedInUrl } from "./normalize";

export type ReactionPerson = {
  profileUrl: string;
  name: string;
  headline?: string;
  jobTitle?: string;
  company?: string;
  type: "REACTION";
  reactionType?: string;
};

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const profile = (v: string) => { const u = normalizeLinkedInUrl(v); return /linkedin\.com\/in\//i.test(u) ? u : ""; };
const generic = (v: string) => /^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business|celebrate|support|love|insightful|funny)$/i.test(clean(v)) || clean(v).length < 2;

async function connectPage(): Promise<{ browser: any; page: Page }> {
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
  if (version.Browser) console.log(`Chrome CDP browser: ${version.Browser}`);
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 90000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connected, but no browser context is available.");
  return { browser, page: await context.newPage() };
}

async function findPostRoot(page: Page, postUrl: string): Promise<Locator | null> {
  const id = postUrl.match(/(?:ugcPost-|activity-)(\d+)/i)?.[1] ?? "";
  if (id) {
    const direct = page.locator(`[data-urn*="${id}"], [data-id*="${id}"]`);
    const n = Math.min(await direct.count().catch(() => 0), 20);
    for (let i = 0; i < n; i++) {
      const node = direct.nth(i);
      if (!(await node.isVisible().catch(() => false))) continue;
      const article = node.locator("xpath=ancestor::article[1]");
      if (await article.count().catch(() => 0)) return article;
      return node;
    }
  }
  const links = page.locator('a[href*="/posts/"], a[href*="/feed/update/"]');
  const n = Math.min(await links.count().catch(() => 0), 100);
  for (let i = 0; i < n; i++) {
    const href = normalizeLinkedInUrl((await links.nth(i).getAttribute("href").catch(() => "")) || "").toLowerCase();
    if (href && id && href.includes(id)) {
      const article = links.nth(i).locator("xpath=ancestor::article[1]");
      if (await article.count().catch(() => 0)) return article;
    }
  }
  return page.locator("article").filter({ hasText: /\breactions?\b|\blikes?\b/i }).first();
}

async function findTrigger(page: Page, postUrl: string): Promise<Locator | null> {
  const root = await findPostRoot(page, postUrl);
  if (!root || !(await root.count().catch(() => 0))) return null;
  const controls = root.locator("button, [role='button'], a, [tabindex='0']");
  const n = Math.min(await controls.count().catch(() => 0), 250);
  const diagnostics: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const text = clean(await c.innerText().catch(() => ""));
    const aria = clean(await c.getAttribute("aria-label").catch(() => ""));
    const title = clean(await c.getAttribute("title").catch(() => ""));
    const data = clean(await c.getAttribute("data-view-name").catch(() => ""));
    const combined = `${text} ${aria} ${title} ${data}`;
    if (/reaction|like/i.test(combined)) diagnostics.push(combined.slice(0, 120));
    if (/^\d[\d,.]*\s+(?:reactions?|likes?)$/i.test(text) || /^\d[\d,.]*\s+(?:reactions?|likes?)$/i.test(aria) || /^\d[\d,.]*\s+(?:reactions?|likes?)$/i.test(title)) return c;
    if (/reaction|like/i.test(combined) && !/reply|follow|my network|notification|messaging/i.test(combined)) return c;
  }
  if (diagnostics.length) console.log(`Reaction control candidates: ${diagnostics.slice(0, 20).join(" | ")}`);
  console.log("No reaction control found inside identified post root.");
  return null;
}

function reactionSurface(page: Page) {
  return page.locator('[role="dialog"], [role="listbox"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]').filter({ hasText: /people who reacted|\breactions?\b|\blikes?\b/i }).last();
}

async function extractSurface(surface: Locator, seen: Set<string>, max: number) {
  const out: ReactionPerson[] = [];
  const anchors = surface.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
  const n = Math.min(await anchors.count().catch(() => 0), 1000);
  for (let i = 0; i < n && out.length < max; i++) {
    const a = anchors.nth(i);
    if (!(await a.isVisible().catch(() => false))) continue;
    const href = profile((await a.getAttribute("href").catch(() => "")) || (await a.getAttribute("data-profile-url").catch(() => "")) || (await a.getAttribute("data-test-profile-url").catch(() => "")) || "");
    const name = clean((await a.textContent().catch(() => "")) || (await a.getAttribute("aria-label").catch(() => "")));
    if (!href || !name || generic(name) || seen.has(href.toLowerCase())) continue;
    seen.add(href.toLowerCase());
    out.push({ profileUrl: href, name, type: "REACTION", reactionType: "UNKNOWN" });
  }
  return out;
}

export async function scrapeReactions(postUrl: string, max = 500): Promise<{ reactions: ReactionPerson[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { browser, page } = await connectPage();
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1800);
    const trigger = await findTrigger(page, postUrl);
    if (!trigger) return { reactions: [], warnings: ["Could not locate the reaction interaction control inside the LinkedIn post."] };
    console.log("Reaction interaction control found by post-scoped detection; clicking it.");
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
    await page.waitForTimeout(1000);

    const seen = new Set<string>();
    const reactions: ReactionPerson[] = [];
    for (let round = 0; round < 50 && reactions.length < max; round++) {
      const surface = reactionSurface(page);
      if (!(await surface.count().catch(() => 0))) {
        if (round === 0) console.log("Reaction surface not detected after click; no page-wide profile fallback will be used.");
        break;
      }
      const found = await extractSurface(surface, seen, max - reactions.length);
      reactions.push(...found);
      if (reactions.length >= max) break;
      const before = clean(await surface.innerText().catch(() => ""));
      await surface.focus().catch(() => {});
      await surface.press("PageDown").catch(() => {});
      await page.waitForTimeout(450);
      const after = clean(await surface.innerText().catch(() => ""));
      if (after === before) break;
    }
    if (!reactions.length) warnings.push("Reaction list opened, but no public LinkedIn profile URLs were exposed inside the reaction surface.");
    console.log(`Reaction extraction enriched records: ${reactions.length}`);
    return { reactions, warnings };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
