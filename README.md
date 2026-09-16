# LinkedIn Lead Finder

A minimal local MVP: enter a LinkedIn post URL, collect commenters/reactions visible to your own logged-in Windows Chrome session, deduplicate people, filter by job-title keywords, and export a CSV.

## Run with Docker on Windows

Install only Docker Desktop. You do **not** need Node.js, npm, npx, Prisma, or Playwright installed on Windows.

This version does **not** create a Chromium browser inside Docker. It connects to the Chrome you already use on Windows through Chrome DevTools Protocol (CDP).

```powershell
git clone https://github.com/huaxiufa/LinkedIn-leader-find.git
cd LinkedIn-leader-find
docker compose up --build
```

## Start Windows Chrome with CDP

Close all normal Chrome windows first, then start Chrome with remote debugging enabled.

Typical Chrome path:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

If Chrome is installed under x86 Program Files, use:

```powershell
& "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

You can also use your existing Chrome shortcut by adding `--remote-debugging-port=9222` to its target.

Then:

1. In that Chrome window, open LinkedIn.
2. Log into LinkedIn normally if needed.
3. Leave Chrome open.
4. Open `http://localhost:3000`.
5. Enter the LinkedIn post URL and run the search.

The Docker worker connects to `http://host.docker.internal:9222` and controls the already-running Windows Chrome. It does not launch or close Chrome.

## Verify CDP before running a search

On Windows, open:

```text
http://localhost:9222/json/version
```

If CDP is enabled, Chrome returns JSON containing a `webSocketDebuggerUrl` field.

## What runs in Docker

- `app`: Next.js web UI/API on port 3000
- `worker`: scraping worker connected to Windows Chrome via CDP
- `postgres`: PostgreSQL database on port 5432

There is no Docker Chromium, VNC/noVNC service, or persisted Chromium profile in this version.

## Scraping behavior

- Uses the user's own normal Windows Chrome LinkedIn login session.
- Reads engagement data exposed to that account in the LinkedIn UI.
- Scrolls the reaction-user panel to load more visible users.
- Deduplicates people by normalized LinkedIn profile URL.
- Enriches visible profiles with headline/job-title information.
- Applies include/exclude title keyword filters.
- Exports results as CSV.

LinkedIn can still limit which reaction users are visible to an account, and the application reports warnings when the reaction list is not exposed.

The scraper does not bypass CAPTCHA, anti-bot systems, rate limits, or access controls, and it does not use stolen cookies or credentials.

## Stop

```powershell
docker compose down
```

## Scope

- LinkedIn post URL input
- Logged-in-session comments/reactions visible in the UI
- Profile deduplication
- Include/exclude title keywords
- CSV export
- No Apify, AI, CRM, outreach, billing, or team features
