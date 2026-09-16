# LinkedIn Lead Finder

A minimal local MVP: enter a LinkedIn post URL, collect publicly accessible commenters/reactions, deduplicate people, filter by job-title keywords, and export a CSV.

## Run with Docker (recommended on Windows)

Install only Docker Desktop. You do **not** need Node.js, npm, npx, Prisma, or Playwright installed on Windows.

```powershell
git clone https://github.com/huaxiufa/LinkedIn-leader-find.git
cd LinkedIn-leader-find
docker compose up --build
```

Then open:

http://localhost:3000

The first build downloads Node dependencies and the Chromium browser into the Docker image. Subsequent starts are much faster.

To stop:

```powershell
docker compose down
```

To stop and remove the local database volume too:

```powershell
docker compose down -v
```

## What runs in Docker

- `app`: Next.js web UI/API on port 3000
- `worker`: Playwright scraping worker
- `postgres`: PostgreSQL database on port 5432

The app and worker automatically run Prisma setup against the Docker PostgreSQL service.

## Scope

- LinkedIn post URL input
- Publicly accessible comments/reactions
- Profile deduplication
- Include/exclude title keywords
- CSV export
- No Apify, AI, CRM, outreach, billing, or team features

The scraper does not bypass login, CAPTCHA, anti-bot systems, rate limits, or access controls. LinkedIn may expose only a subset of engagement data without authentication.
