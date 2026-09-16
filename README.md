# LinkedIn Lead Finder

A minimal local MVP: enter a LinkedIn post URL, collect commenters/reactions visible to your own logged-in LinkedIn session, deduplicate people, filter by job-title keywords, and export a CSV.

## Run with Docker (recommended on Windows)

Install only Docker Desktop. You do **not** need Node.js, npm, npx, Prisma, or Playwright installed on Windows.

```powershell
git clone https://github.com/huaxiufa/LinkedIn-leader-find.git
cd LinkedIn-leader-find
docker compose up --build
```

Then open:

- App: http://localhost:3000
- LinkedIn browser login: http://localhost:7900/vnc.html

## First-time LinkedIn login

1. Start the stack with `docker compose up --build`.
2. Open `http://localhost:7900/vnc.html`.
3. The VNC page shows the Chromium browser running inside Docker.
4. In that browser, go to LinkedIn and log in normally with your own account.
5. Leave the browser container running. The login profile is persisted in the Docker volume `linkedin_profile`.
6. Open `http://localhost:3000`, enter the LinkedIn post URL, and run the search.

The scraper connects to this persistent browser session over Playwright CDP. It does not ask the worker to bypass LinkedIn login or access controls.

## Subsequent starts

Your LinkedIn browser profile is persisted, so normally you can just run:

```powershell
docker compose up
```

If LinkedIn asks you to sign in again, open `http://localhost:7900/vnc.html` and complete the normal login flow again.

## Stop

```powershell
docker compose down
```

To stop and remove the local database **and** saved LinkedIn login profile:

```powershell
docker compose down -v
```

## What runs in Docker

- `app`: Next.js web UI/API on port 3000
- `browser`: persistent Chromium + VNC/noVNC on port 7900 and Playwright CDP on port 9222
- `worker`: Playwright scraping worker connected to the browser session
- `postgres`: PostgreSQL database on port 5432

The app and worker automatically run Prisma setup against the Docker PostgreSQL service.

## Scraping behavior

- Uses the user's own normal LinkedIn login session when available.
- Reads engagement data exposed to that account in the LinkedIn UI.
- Scrolls the reaction-user panel to load more visible users.
- Deduplicates people by normalized LinkedIn profile URL.
- Enriches visible profiles with headline/job-title information.
- Applies include/exclude job-title keyword filters.
- Exports results as CSV.

LinkedIn can still limit which reaction users are visible to an account, and the application reports warnings when the reaction list is not exposed.

The scraper does not bypass CAPTCHA, anti-bot systems, rate limits, or access controls, and it does not use stolen cookies or credentials.

## Scope

- LinkedIn post URL input
- Logged-in-session comments/reactions visible in the UI
- Profile deduplication
- Include/exclude title keywords
- CSV export
- No Apify, AI, CRM, outreach, billing, or team features
