import { db } from "../lib/db";
import { scrapePublicPost } from "../lib/scraper";
import { normalizeLinkedInUrl } from "../lib/normalize";

const pollMs = Number(process.env.SCRAPER_POLL_MS ?? 3000);

async function processOne() {
  const search = await db.search.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });

  if (!search) return false;

  await db.search.update({
    where: { id: search.id },
    data: { status: "RUNNING", startedAt: new Date(), error: null },
  });

  try {
    const result = await scrapePublicPost(search.postUrl, {
      maxComments: Number(process.env.SCRAPER_MAX_COMMENTS ?? 500),
      maxReactions: Number(process.env.SCRAPER_MAX_REACTIONS ?? 500),
    });

    for (const item of result.engagements) {
      const linkedinUrl = normalizeLinkedInUrl(item.profileUrl);

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

      await db.engagement.upsert({
        where: {
          searchId_profileId_type: {
            searchId: search.id,
            profileId: profile.id,
            type: item.type,
          },
        },
        update: {
          reactionType: item.reactionType,
          commentText: item.commentText,
          engagedAt: item.engagedAt,
        },
        create: {
          searchId: search.id,
          profileId: profile.id,
          type: item.type,
          reactionType: item.reactionType,
          commentText: item.commentText,
          engagedAt: item.engagedAt,
        },
      });
    }

    const warning = result.warnings.length
      ? `Completed with warnings: ${result.warnings.join(" | ")}`
      : null;

    await db.search.update({
      where: { id: search.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        error: warning,
      },
    });
  } catch (err) {
    await db.search.update({
      where: { id: search.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: err instanceof Error ? err.message : "Scraper failed.",
      },
    });
  }

  return true;
}

async function main() {
  console.log("Scraper worker started.");

  while (true) {
    const processed = await processOne();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
