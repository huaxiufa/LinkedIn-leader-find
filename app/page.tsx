"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [postUrl, setPostUrl] = useState("");
  const [includeKeywords, setIncludeKeywords] = useState("CEO, Founder, Co-Founder, VP, Head of, Director");
  const [excludeKeywords, setExcludeKeywords] = useState("Intern, Student");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postUrl, includeKeywords, excludeKeywords }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create search");
      router.push(`/search/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <div className="card" style={{ maxWidth: 760, margin: "60px auto" }}>
        <h1>LinkedIn Lead Finder</h1>
        <p className="muted">
          Enter a LinkedIn post URL, collect publicly accessible engagement data,
          deduplicate people, and filter by job title.
        </p>

        <form onSubmit={submit}>
          <label>LinkedIn Post URL</label>
          <input
            required
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
            placeholder="https://www.linkedin.com/posts/..."
          />

          <label>Include Job Title Keywords</label>
          <textarea
            value={includeKeywords}
            onChange={(e) => setIncludeKeywords(e.target.value)}
            placeholder="CEO, Founder, Marketing Director"
          />

          <label>Exclude Job Title Keywords</label>
          <textarea
            value={excludeKeywords}
            onChange={(e) => setExcludeKeywords(e.target.value)}
            placeholder="Intern, Student"
          />

          <div style={{ marginTop: 20 }}>
            <button disabled={loading}>
              {loading ? "Creating search..." : "Find Leads"}
            </button>
          </div>

          {error && <div className="error">{error}</div>}
        </form>

        <div className="notice">
          This MVP does not bypass LinkedIn login, CAPTCHA, anti-bot systems,
          rate limits, or access controls. Results depend on what the current
          public page exposes.
        </div>
      </div>
    </main>
  );
}
