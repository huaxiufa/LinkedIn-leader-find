import { chromium } from "playwright";
import { db } from "../lib/db";
import { scrapePublicPost } from "../lib/scraper";
import { normalizeLinkedInUrl } from "../lib/normalize";

// Playwright's Browser returned by connectOverCDP exposes close(), not disconnect().
// The scraper currently calls disconnect() in its cleanup path. Bridge that call
// to browser.close(), which disconnects the Playwright CDP client while leaving
// the externally launched Chrome process running. Also normalize the browser
// WebSocket URL to the HTTP CDP endpoint: this avoids cases where the WebSocket
// handshake succeeds but Playwright's CDP initialization stalls inside Docker.
const originalConnectOverCDP = chromium.connectOverCDP.bind(chromium);
(chromium as any).connectOverCDP = async (...args: any[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("ws://")) {
    try {
      const ws = new URL(args[0]);
      args[0] = `http://${ws.hostname}:${ws.port || "9222"}`;
      console.log(`Normalizing Chrome CDP WebSocket endpoint to ${args[0]}`);
    } catch {
      // Leave the original endpoint untouched if it is not a parseable URL.
    }
  }
  if (!args[1] || typeof args[1] !== "object") args[1] = {};
  args[1] = { ...args[1], timeout: Math.max(Number(args[1].timeout ?? 0), 90000) };
  const browser = await originalConnectOverCDP(...args);
  (browser as any).disconnect = () => {
    void browser.close().catch(() => {});
  };
  return browser;
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

        for (const item of result.engagements) {
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
