# LinkedIn Lead Finder

A minimal local MVP for finding potential leads from a LinkedIn post.

## What it does

1. Input a LinkedIn post URL.
2. Collect publicly accessible commenters and reaction users when the page exposes them.
3. Deduplicate people by LinkedIn profile URL.
4. Filter by job-title/headline keywords, with include and exclude lists.
5. Export the matched lead list as CSV.

## Stack

- Next.js + TypeScript
- PostgreSQL + Prisma
- Playwright scraper worker

## Setup

```bash
cp .env.example .env
docker compose up -d
npm install
npx playwright install chromium
npx prisma generate
npx prisma db push
npm run dev
```

In another terminal:

```bash
npm run worker
```

Then open `http://localhost:3000`.

## Notes

This version intentionally does **not** use Apify, AI, CRM integrations, outreach, billing, or team features.

The scraper only uses data normally exposed by the current page. It does not bypass LinkedIn login, CAPTCHA, anti-bot systems, rate limits, or access controls. LinkedIn may expose only a subset of engagement data without authentication, so reaction results can be incomplete.
