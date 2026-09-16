export function normalizeLinkedInUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
    return url.toString();
  } catch {
    return input.trim().toLowerCase();
  }
}

export function parseKeywords(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}
