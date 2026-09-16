import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizeLinkedInUrl, parseKeywords } from "@/lib/normalize";

function isLinkedInPostUrl(value: string) {
  try {
    const u = new URL(value);
    return (u.hostname === "linkedin.com" || u.hostname === "www.linkedin.com" || u.hostname.endsWith(".linkedin.com"))
      && (u.pathname.includes("/posts/") || u.pathname.includes("/feed/update/"));
  } catch {
    return false;
  }
}

function parseLines(value: unknown) {
  return String(value ?? "")
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const postUrls = parseLines(body.postUrls ?? body.postUrl);
    const validUrls = [...new Set(postUrls.filter(isLinkedInPostUrl))];

    if (!validUrls.length) {
      return NextResponse.json({ error: "Please enter at least one valid LinkedIn post URL." }, { status: 400 });
    }

    const maxEngagersPerPost = Math.min(5000, Math.max(1, Number(body.maxEngagersPerPost ?? 500)));
    const suppressionUrls = [...new Set(parseLines(body.suppressionUrls).map(normalizeLinkedInUrl).filter(Boolean))];

    const search = await db.search.create({
      data: {
        postUrl: validUrls[0],
        postUrls: validUrls,
        includeKeywords: parseKeywords(body.includeKeywords),
        excludeKeywords: parseKeywords(body.excludeKeywords),
        suppressionUrls,
        maxEngagersPerPost,
      },
    });

    return NextResponse.json({ id: search.id });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Unable to create search." }, { status: 500 });
  }
}
