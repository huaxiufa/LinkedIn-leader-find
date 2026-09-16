import { db } from "../lib/db";
import { scrapePublicPost } from "../lib/scraper";
import { normalizeLinkedInUrl } from "../lib/normalize";

const pollMs = Number(process.env.SCRAPER_POLL_MS ?? 3000);

async function processOne() {
  const search = await db.search.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!search) return false;

  await db.search.update({ where: { id: search.id }, data: { status: "RUNNING", startedAt: new Date(), error: null } });

  try {
    const postUrls = search.postUrls.length ? search.postUrls : [search.postUrl];
    const suppression = new Set(search.suppressionUrls.map(normalizeLinkedInUrl));
    const warnings: string[] = [];

    for (const postUrl of postUrls) {
      try {
        const result = await scrapePublicPost(postUrl, {
          maxComments: search.maxEngagersPerPost,
          maxReactions: search.maxEngagersPerPost,
        });
        warnings.push(...result.warnings.map((w) => `${postUrl}: ${w}`));

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
            // A comment is the stronger engagement signal. Replace any reaction row.
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
        error: warnings.length ? `Completed with warnings: ${warnings.join(" | ")}` : null,
      },
    });
  } catch (err) {
    await db.search.update({
      where: { id: search.id },
      data: { status: "FAILED", completedAt: new Date(), error: err instanceof Error ? err.message : "Scraper failed." },
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
