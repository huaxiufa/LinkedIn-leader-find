# LinkedIn Lead Finder

A minimal local MVP: enter one or more LinkedIn post URLs, collect commenters/reactions visible to your own Windows Chrome session, deduplicate people, filter by job-title keywords, and export a CSV.

## Run with Docker on Windows

Install only Docker Desktop. You do **not** need Node.js, npm, npx, Prisma, or Playwright installed on Windows.

This version connects to the Chrome you run on Windows through Chrome DevTools Protocol (CDP). The Lead Finder Chrome uses a dedicated persistent profile at `chrome-profile` inside this project folder.

```powershell
git clone https://github.com/huaxiufa/LinkedIn-leader-find.git
cd LinkedIn-leader-find
```

## Start the persistent Lead Finder Chrome

Use the included `start-chrome.bat`.

The launcher uses:

```text
<project-folder>\chrome-profile
```

This is a dedicated Chrome user-data directory. Chrome stores profile state such as cookies and other local session data in its user-data directory, so reusing the same directory lets the Lead Finder reuse the browser session across application restarts. citeturn0search0turn0search4

First run:

1. Run `start-chrome.bat`.
2. A dedicated Lead Finder Chrome window opens.
3. Open LinkedIn and log in normally.
4. Keep that Chrome window open.
5. Run Docker:

```powershell
docker compose up --build
```

Later runs:

1. Run `start-chrome.bat` again.
2. The same `chrome-profile` directory is reused.
3. If the LinkedIn session is still valid, you normally do not need to log in again.
4. Run `docker compose up --build`.

**Do not delete `chrome-profile`** if you want to keep the saved browser session. If LinkedIn itself expires or invalidates the session, you will need to log in again normally.

The launcher no longer force-closes all Chrome processes. It only reuses the dedicated Lead Finder Chrome when CDP is already available.

## LinkedIn login status detection

The worker checks the connected LinkedIn page for the normal signed-out indicators exposed by the UI.

The results page shows:

- `LinkedIn session: SIGNED IN`
- `LinkedIn session: SIGNED OUT`
- `LinkedIn session: UNKNOWN`

If it detects `SIGNED OUT`, log into LinkedIn in the dedicated Lead Finder Chrome window and run the search again.

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

There is no separate browser login inside Docker. The worker uses your Windows Chrome through CDP.

## Scraping behavior

- Uses the user's own Windows Chrome LinkedIn login session.
- Reads engagement data exposed to that account in the LinkedIn UI.
- Scrolls the reaction-user panel to load more visible users.
- Deduplicates people by normalized LinkedIn profile URL.
- Gives comments priority over reactions for the same person.
- Applies include/exclude title keyword filters.
- Exports results as CSV.

LinkedIn can still limit which reaction users are visible to an account, and the application reports warnings when the reaction list is not exposed.

The scraper does not bypass CAPTCHA, anti-bot systems, rate limits, or access controls, and it does not use stolen cookies or credentials.

## Stop

```powershell
docker compose down
```

You can close the dedicated Lead Finder Chrome separately when you are finished. The `chrome-profile` directory remains on disk so the session can be reused next time.

## Scope

- LinkedIn post URL input
- Logged-in-session comments/reactions visible in the UI
- Profile deduplication
- Include/exclude title keywords
- Persistent dedicated Chrome session
- LinkedIn session status detection
- CSV export
- No Apify, AI, CRM, outreach, billing, or team features
