export function matchesJobTitle(
  title: string | null | undefined,
  includeKeywords: string[],
  excludeKeywords: string[]
): boolean {
  const normalized = (title ?? "").toLowerCase().trim();

  if (
    excludeKeywords.some((keyword) =>
      normalized.includes(keyword.toLowerCase().trim())
    )
  ) {
    return false;
  }

  if (includeKeywords.length === 0) return true;

  return includeKeywords.some((keyword) =>
    normalized.includes(keyword.toLowerCase().trim())
  );
}
