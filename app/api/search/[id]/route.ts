import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const search = await db.search.findUnique({
    where: { id },
    include: { engagements: { include: { profile: true }, orderBy: { createdAt: "asc" } } },
  });

  if (!search) return NextResponse.json({ error: "Search not found." }, { status: 404 });

  const results = search.engagements.map((e) => ({
    id: e.profile.id,
    name: e.profile.name,
    headline: e.profile.headline,
    jobTitle: e.profile.jobTitle,
    company: e.profile.company,
    linkedinUrl: e.profile.linkedinUrl,
    engagement: e.type,
    reactionType: e.reactionType,
    commentText: e.commentText,
    engagedAt: e.engagedAt,
    postUrl: e.postUrl,
  }));

  const uniquePeople = new Set(search.engagements.map((e) => e.profileId)).size;
  const matchedPeople = new Set(
    search.engagements.map((e) => e.profileId)
  ).size;

  return NextResponse.json({
    id: search.id,
    postUrl: search.postUrl,
    postUrls: search.postUrls.length ? search.postUrls : [search.postUrl],
    status: search.status,
    error: search.error,
    includeKeywords: search.includeKeywords,
    excludeKeywords: search.excludeKeywords,
    suppressionCount: search.suppressionUrls.length,
    maxEngagersPerPost: search.maxEngagersPerPost,
    totalEngagements: search.engagements.length,
    uniquePeople,
    matchedPeople,
    results,
  });
}
