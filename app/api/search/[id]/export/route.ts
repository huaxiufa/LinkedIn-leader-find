import { db } from "@/lib/db";
import { matchesJobTitle } from "@/lib/title-filter";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const search = await db.search.findUnique({ where: { id }, include: { engagements: { include: { profile: true } } } });
  if (!search) return new Response("Search not found", { status: 404 });

  const header = ["name", "job_title", "headline", "company", "engagement", "reaction_type", "comment", "engaged_at", "post_url", "linkedin_url"];
  const matched = search.engagements.filter((e) => matchesJobTitle(e.profile.jobTitle || e.profile.headline, search.includeKeywords, search.excludeKeywords));
  const unique = new Map<string, typeof matched[number]>();
  for (const e of matched) if (!unique.has(e.profileId)) unique.set(e.profileId, e);
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    header.join(","),
    ...[...unique.values()].map((e) => [e.profile.name, e.profile.jobTitle, e.profile.headline, e.profile.company, e.type, e.reactionType, e.commentText, e.engagedAt?.toISOString(), e.postUrl, e.profile.linkedinUrl].map(escape).join(",")),
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="linkedin-leads-${id}.csv"`,
    },
  });
}
