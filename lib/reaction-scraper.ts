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

function clean(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function profileUrl(value: string) {
  const url = normalizeLinkedInUrl(value);
  return /linkedin\.com\/in\//i.test(url) ? url : "";
}

function isGenericLabel(value: string) {
  const text = clean(value).toLowerCase();
  if (!text || text.length < 2 || text.length > 140) return true;
  return /^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business)$/i.test(text);
}

function looksLikeHeadline(value: string, name: string) {
  const text = clean(value);
  if (!text || text === name || isGenericLabel(text)) return false;
  if (/^(follow|connect|message|more|see more|open to work|contact info)$/i.test(text)) return false;
  return text.length >= 5 && text.length <= 240;
}

async function connectPage(): Promise<{ browser: any; page: Page }> {
  const configured = new URL(process.env.LINKEDIN_CDP_URL ?? "http://host.docker.internal:9222");
  let host = configured.hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host !== "localhost") {
    const addresses = await lookup(host, { all: true });
    const ipv4 = addresses.find((entry) => entry.family === 4);
    if (!ipv4) throw new Error(`Could not resolve ${host} to IPv4.`);
    host = ipv4.address;
  }
  const endpoint = `http://${host}:${configured.port || "9222"}`;
  const response = await fetch(`${endpoint}/json/version`, { headers: { Host: host } });
  if (!response.ok) throw new Error(`Chrome CDP endpoint returned HTTP ${response.status}.`);
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 90000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connected, but no browser context is available.");
  return { browser, page: await context.newPage() };
}

async function findClickableReactionControl(page: Page, postUrl: string): Promise<Locator | null> {
  const postId = postUrl.match(/(?:ugcPost-|activity-)(\d+)/i)?.[1] ?? "";
  const roots: Locator[] = [];
  if (postId) roots.push(page.locator(`[data-urn*="${postId}"], [data-id*="${postId}"]`).first());
  roots.push(page.locator("article").filter({ hasText: /\breactions?\b/i }).first());

  for (const root of roots) {
    if (!(await root.count().catch(() => 0)) || !(await root.isVisible().catch(() => false))) continue;
    if (!/\breactions?\b/i.test(clean(await root.innerText().catch(() => "")))) continue;

    const exactTexts = root.getByText(/^\d+\s+reactions?$/i);
    const exactCount = Math.min(await exactTexts.count().catch(() => 0), 20);
    for (let i = 0; i < exactCount; i++) {
      const textNode = exactTexts.nth(i);
      if (!(await textNode.isVisible().catch(() => false))) continue;
      const clickable = textNode.locator("xpath=ancestor::*[self::button or @role='button' or self::a or @tabindex='0'][1]");
      if (await clickable.count().catch(() => 0)) return clickable;
      return textNode;
    }

    const candidates = root.locator("button, [role='button'], a, [tabindex='0']");
    const count = Math.min(await candidates.count().catch(() => 0), 500);
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = clean((await candidate.innerText().catch(() => "")) || (await candidate.getAttribute("aria-label").catch(() => "")) || (await candidate.getAttribute("title").catch(() => "")));
      if (/^\d+\s+reactions?$/i.test(label)) return candidate;
    }
  }

  const exactTexts = page.getByText(/^\d+\s+reactions?$/i);
  const count = Math.min(await exactTexts.count().catch(() => 0), 30);
  for (let i = 0; i < count; i++) {
    const textNode = exactTexts.nth(i);
    if (!(await textNode.isVisible().catch(() => false))) continue;
    const clickable = textNode.locator("xpath=ancestor::*[self::button or @role='button' or self::a or @tabindex='0'][1]");
    if (await clickable.count().catch(() => 0)) return clickable;
  }
  return null;
}

function reactionSurface(page: Page) {
  const surfaces = page.locator('[role="dialog"], [role="listbox"], [role="list"], [role="tabpanel"], .artdeco-modal, .artdeco-popover, [data-test-modal], [data-test-dialog], [data-test-popover]');
  return surfaces.filter({ hasText: /people who reacted|reactions?|likes?/i }).last();
}

async function extractFromSurface(surface: Locator, seen: Set<string>, max: number) {
  const result: ReactionPerson[] = [];
  const anchors = surface.locator('a[href*="/in/"], a[data-profile-url], a[data-test-profile-url]');
  const count = Math.min(await anchors.count().catch(() => 0), 3000);
  for (let i = 0; i < count && result.length < max; i++) {
    const anchor = anchors.nth(i);
    const href = profileUrl((await anchor.getAttribute("href").catch(() => "")) || (await anchor.getAttribute("data-profile-url").catch(() => "")) || (await anchor.getAttribute("data-test-profile-url").catch(() => "")) || "");
    if (!href || seen.has(href.toLowerCase())) continue;
    const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
    if (!name || isGenericLabel(name)) continue;
    seen.add(href.toLowerCase());
    result.push({ profileUrl: href, name, type: "REACTION", reactionType: "UNKNOWN" });
  }
  return result;
}

async function extractGlobalProfileLinks(page: Page, seen: Set<string>, max: number) {
  const result: ReactionPerson[] = [];
  const anchors = page.locator('a[href*="/in/"]');
  const count = Math.min(await anchors.count().catch(() => 0), 3000);
  for (let i = 0; i < count && result.length < max; i++) {
    const anchor = anchors.nth(i);
    if (!(await anchor.isVisible().catch(() => false))) continue;
    const href = profileUrl(await anchor.getAttribute("href").catch(() => ""));
    if (!href || seen.has(href.toLowerCase())) continue;
    const name = clean((await anchor.textContent().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")));
    if (!name || isGenericLabel(name)) continue;
    seen.add(href.toLowerCase());
    result.push({ profileUrl: href, name, type: "REACTION", reactionType: "UNKNOWN" });
  }
  return result;
}

async function extractViaHoverCards(page: Page, surface: Locator, seen: Set<string>, max: number) {
  const result: ReactionPerson[] = [];
  const candidates = surface.locator('a, [role="link"], button, [role="button"], [tabindex="0"], span.hoverable-link-text, [class*="hoverable-link-text"]');
  const count = Math.min(await candidates.count().catch(() => 0), 120);
  const labels: string[] = [];

  for (let i = 0; i < count && result.length < max; i++) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = clean((await candidate.innerText().catch(() => "")) || (await candidate.getAttribute("aria-label").catch(() => "")) || (await candidate.getAttribute("title").catch(() => "")));
    if (isGenericLabel(label)) continue;
    if (labels.length < 10) labels.push(label);

    await candidate.hover({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(300);

    const hoverLinks = page.locator('a[href*="/in/"]');
    const linkCount = Math.min(await hoverLinks.count().catch(() => 0), 3000);
    for (let j = 0; j < linkCount && result.length < max; j++) {
      const link = hoverLinks.nth(j);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = profileUrl(await link.getAttribute("href").catch(() => ""));
      if (!href || seen.has(href.toLowerCase())) continue;
      const name = clean((await link.textContent().catch(() => "")) || label);
      if (!name || isGenericLabel(name)) continue;

      let headline = "";
      const card = link.locator("xpath=ancestor::*[self::div or self::section or @role='dialog'][1]");
      if (await card.count().catch(() => 0)) {
        const lines = (await card.innerText().catch(() => ""))
          .split("\n")
          .map((line) => clean(line))
          .filter(Boolean);
        const candidateHeadline = lines.find((line) => looksLikeHeadline(line, name));
        if (candidateHeadline) headline = candidateHeadline;
      }

      seen.add(href.toLowerCase());
      result.push({
        profileUrl: href,
        name,
        headline: headline || undefined,
        jobTitle: headline || undefined,
        type: "REACTION",
        reactionType: "UNKNOWN",
      });
    }
  }

  console.log(`Reaction hover diagnostics: candidates=${count}, sampleLabels=${JSON.stringify(labels)}`);
  return result;
}

export async function scrapeReactions(postUrl: string, max = 500): Promise<{ reactions: ReactionPerson[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { browser, page } = await connectPage();
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const trigger = await findClickableReactionControl(page, postUrl);
    if (!trigger) {
      const candidates = page.getByText(/\d+\s+reactions?/i);
      console.log(`Reaction control diagnostic: matching text nodes=${await candidates.count().catch(() => 0)}`);
      warnings.push("Could not locate the reaction count control inside the LinkedIn post.");
      return { reactions: [], warnings };
    }

    console.log("Reaction control found by exact reaction-count text; clicking it.");
    await trigger.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await trigger.click({ timeout: 5000 }).catch(async () => trigger.click({ timeout: 5000, force: true }));
    await page.waitForTimeout(1200);

    const seen = new Set<string>();
    const reactions: ReactionPerson[] = [];

    for (let round = 0; round < 30 && reactions.length < max; round++) {
      const surface = reactionSurface(page);
      if (!(await surface.count().catch(() => 0))) break;
      const found = await extractFromSurface(surface, seen, max - reactions.length);
      reactions.push(...found);
      if (reactions.length >= max) break;
      const before = clean(await surface.innerText().catch(() => ""));
      await surface.focus().catch(() => {});
      await surface.press("PageDown").catch(() => {});
      await page.waitForTimeout(400);
      const after = clean(await surface.innerText().catch(() => ""));
      if (after === before) break;
    }

    if (reactions.length < max) {
      const globalFound = await extractGlobalProfileLinks(page, seen, max - reactions.length);
      reactions.push(...globalFound);
    }

    if (!reactions.length) {
      const surface = reactionSurface(page);
      if (await surface.count().catch(() => 0)) {
        const hovered = await extractViaHoverCards(page, surface, seen, max);
        reactions.push(...hovered);
      }
    }

    if (!reactions.length) {
      const surface = reactionSurface(page);
      const surfaceText = clean(await surface.innerText().catch(() => ""));
      console.log(`Reaction list diagnostics: surfaceCount=${await surface.count().catch(() => 0)}, text=${JSON.stringify(surfaceText.slice(0, 1200))}`);
      warnings.push("Reaction list opened, but no public LinkedIn profile URLs were exposed.");
    }

    console.log(`Reaction extraction enriched records: ${reactions.length}`);
    return { reactions, warnings };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
