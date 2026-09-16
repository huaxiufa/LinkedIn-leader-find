# LinkedIn Lead Finder

A minimal local MVP: enter a LinkedIn post URL, collect publicly accessible commenters/reactions, deduplicate people, filter by job-title keywords, and export a CSV.

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

Open http://localhost:3000.

## Scope

- LinkedIn post URL input
- Publicly accessible comments/reactions
- Profile deduplication
- Include/exclude title keywords
- CSV export
- No Apify, AI, CRM, outreach, billing, or team features

The scraper does not bypass login, CAPTCHA, anti-bot systems, rate limits, or access controls. LinkedIn may expose only a subset of engagement data without authentication.
