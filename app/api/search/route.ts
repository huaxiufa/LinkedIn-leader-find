import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseKeywords } from "@/lib/normalize";

function isLinkedInPostUrl(value: string) {
  try {
    const u = new URL(value);
    return u.hostname === "linkedin.com" ||
      u.hostname === "www.linkedin.com" ||
      u.hostname.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const postUrl = String(body.postUrl ?? "").trim();

    if (!isLinkedInPostUrl(postUrl)) {
      return NextResponse.json({ error: "Please enter a valid LinkedIn URL." }, { status: 400 });
    }

    const search = await db.search.create({
      data: {
        postUrl,
        includeKeywords: parseKeywords(body.includeKeywords),
        excludeKeywords: parseKeywords(body.excludeKeywords),
      },
    });

    return NextResponse.json({ id: search.id });
  } catch {
    return NextResponse.json({ error: "Unable to create search." }, { status: 500 });
  }
}
