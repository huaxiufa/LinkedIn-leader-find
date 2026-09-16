import { chromium } from "playwright";

const profileDir = process.env.LINKEDIN_PROFILE_DIR ?? "/data/linkedin-profile";
const display = process.env.DISPLAY ?? ":99";
const cdpPort = Number(process.env.LINKEDIN_CDP_PORT ?? 9222);

async function main() {
  console.log(`Starting LinkedIn browser session on ${display}, CDP ${cdpPort}...`);

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    // Playwright normally uses a private remote-debugging pipe. Remove that
    // default so Chromium exposes the TCP CDP endpoint used by the scraper.
    ignoreDefaultArgs: ["--remote-debugging-pipe"],
    args: [
      `--display=${display}`,
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=0.0.0.0",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  console.log("LinkedIn browser is ready.");
  console.log(`CDP endpoint: http://0.0.0.0:${cdpPort}`);
  console.log("Open http://localhost:7900/vnc.html in your browser to control it.");
  console.log("Log into LinkedIn normally. The browser profile is persisted in /data/linkedin-profile.");

  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
