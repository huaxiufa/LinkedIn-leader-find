import { chromium } from "playwright";
import { db } from "../lib/db";
import { scrapePublicPost } from "../lib/scraper";
import { scrapeReactions } from "../lib/reaction-scraper";
import { normalizeLinkedInUrl } from "../lib/normalize";

// Playwright's Browser returned by connectOverCDP exposes close(), not disconnect().
// The scraper currently calls disconnect() in its cleanup path. Bridge that call
// to browser.close(), which disconnects the Playwright CDP client while leaving
// the externally launched Chrome process running.
const originalConnectOverCDP = chromium.connectOverCDP.bind(chromium);
(chromium as any).connectOverCDP = async (...args: any[]) => {
  const configuredEndpoint = String(args[0] ?? "http://host.docker.internal:9222");
  let endpoint = configuredEndpoint;

  if (configuredEndpoint.startsWith("ws://") || configuredEndpoint.startsWith("wss://")) {
    try {
      const ws = new URL(configuredEndpoint);
      endpoint = `http://${ws.hostname}:${ws.port || "9222"}`;
    } catch {
      endpoint = configuredEndpoint;
    }
  }

  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    console.log(`Chrome CDP connection endpoint: ${endpoint}`);
  }

  // A Chrome CDP websocket can occasionally accept the TCP/WebSocket connection
  // but stall during Playwright's CDP initialization. Treat that as transient:
  // refresh /json/version and retry instead of asking the user to restart Chrome.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let connectEndpoint = endpoint;
      try {
        const versionResponse = await fetch(`${endpoint}/json/version`, {
          headers: { Host: new URL(endpoint).hostname },
          signal: AbortSignal.timeout(5000),
        });
        if (!versionResponse.ok) throw new Error(`Chrome CDP returned HTTP ${versionResponse.status}.`);
        const version = await versionResponse.json() as { Browser?: string; webSocketDebuggerUrl?: string };
        if (version.Browser) console.log(`Chrome CDP browser: ${version.Browser}`);
        // Prefer the fresh browser endpoint from Chrome, but connect through the
        // HTTP CDP endpoint. Playwright will retrieve the current websocket URL.
        if (version.webSocketDebuggerUrl) {
          connectEndpoint = endpoint;
        }
      } catch (err) {
        lastError = err;
        throw err;
      }

      const options = { ...(args[1] ?? {}), timeout: 20000 };
      const browser = await originalConnectOverCDP(connectEndpoint, options);
      (browser as any).disconnect = () => {
        void browser.close().catch(() => {});
      };
      if (attempt > 1) console.log(`Chrome CDP recovered on connection attempt ${attempt}.`);
      return browser;
    } catch (err) {
      lastError = err;
      console.warn(`Chrome CDP connection attempt ${attempt}/5 failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not connect to Chrome over CDP after 5 attempts.");
};

const pollMs = Number(process.env.SCRAPER_POLL_MS ?? 3000);

async function processOne() {
  const search = await db.search.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!search) return false;

  await db.search.update({ where: { id: search.id }, data: { status: "RUNNING", startedAt: new Date(), error: null, sessionStatus: "UNKNOWN" } });

  try {
    const postUrls = search.postUrls.length ? search.postUrls : [search.postUrl];
    const suppression = new Set(search.suppressionUrls.map(normalizeLinkedInUrl));
    const warnings: string[] = [];
    let sessionStatus: "SIGNED_IN" | "SIGNED_OUT" | "UNKNOWN" = "UNKNOWN";

    for (const postUrl of postUrls) {
      try {
        const result = await scrapePublicPost(postUrl, {
          maxComments: search.maxEngagersPerPost,
          maxReactions: search.maxEngagersPerPost,
        });
        warnings.push(...result.warnings.map((w) => `${postUrl}: ${w}`));

        if (result.warnings.some((w) => /appears to be signed out of LinkedIn/i.test(w))) {
          sessionStatus = "SIGNED_OUT";
        } else if (sessionStatus !== "SIGNED_OUT") {
          sessionStatus = "SIGNED_IN";
        }

        let engagements = result.engagements;

        // LinkedIn changes the reaction-count DOM frequently. If the main
        // scraper could not obtain reactions, use the dedicated reaction path
        // that targets the exact visible "N reactions" text and its clickable
        // ancestor inside the post.
        if (!engagements.some((item) => item.type === "REACTION")) {
          console.log("Primary reaction extraction returned 0; trying dedicated reaction extractor.");
          const fallback = await scrapeReactions(postUrl, search.maxEngagersPerPost);
          if (fallback.reactions.length) {
            engagements = [...engagements, ...fallback.reactions];
            // Remove only reaction-extraction warnings from the primary pass
            // when the fallback successfully recovered the reaction list.
            for (let i = warnings.length - 1; i >= 0; i--) {
              if (warnings[i].startsWith(`${postUrl}:`) && /reaction/i.test(warnings[i])) warnings.splice(i, 1);
            }
          } else {
            warnings.push(...fallback.warnings.map((w) => `${postUrl}: ${w}`));
          }
        }

        for (const item of engagements) {
          const linkedinUrl = normalizeLinkedInUrl(item.profileUrl);
          if (!linkedinUrl || suppression.has(linkedinUrl)) continue;

          const profile = await db.profile.upsert({
            where: { linkedinUrl },
            update: {
              name: item.name,
              headline: item.headline ?? undefined,
              jobTitle: item.jobTitle ?? undefined,
              company: item.company ?? undefined,
            },
            create: {
              linkedinUrl,
              name: item.name,
              headline: item.headline,
              jobTitle: item.jobTitle,
              company: item.company,
            },
          });

          if (item.type === "COMMENT") {
            await db.engagement.deleteMany({ where: { searchId: search.id, profileId: profile.id, type: "REACTION" } });
          } else {
            const existingComment = await db.engagement.findFirst({ where: { searchId: search.id, profileId: profile.id, type: "COMMENT" } });
            if (existingComment) continue;
          }

          await db.engagement.upsert({
            where: { searchId_profileId_type: { searchId: search.id, profileId: profile.id, type: item.type } },
            update: {
              postUrl,
              reactionType: item.reactionType,
              commentText: item.commentText,
              engagedAt: item.engagedAt,
            },
            create: {
              searchId: search.id,
              profileId: profile.id,
              type: item.type,
              postUrl,
              reactionType: item.reactionType,
              commentText: item.commentText,
              engagedAt: item.engagedAt,
            },
          });
        }

        console.log(`Total engagement extraction: ${engagements.length} profile(s) captured.`);
      } catch (err) {
        warnings.push(`${postUrl}: ${err instanceof Error ? err.message : "Scrape failed."}`);
      }
    }

    await db.search.update({
      where: { id: search.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        sessionStatus,
        error: warnings.length ? `Completed with warnings: ${warnings.join(" | ")}` : null,
      },
    });
  } catch (err) {
    await db.search.update({
      where: { id: search.id },
      data: { status: "FAILED", completedAt: new Date(), sessionStatus: "UNKNOWN", error: err instanceof Error ? err.message : "Scraper failed." },
    });
  }

  return true;
}

async function main() {
  console.log("Scraper worker started.");
  while (true) {
    const processed = await processOne();
    if (!processed) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
