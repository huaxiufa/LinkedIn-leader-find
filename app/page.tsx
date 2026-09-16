"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [postUrls, setPostUrls] = useState("");
  const [includeKeywords, setIncludeKeywords] = useState("founder, CEO, co-founder, VP, head of, director, growth, marketing");
  const [excludeKeywords, setExcludeKeywords] = useState("student, intern");
  const [suppressionUrls, setSuppressionUrls] = useState("");
  const [maxEngagersPerPost, setMaxEngagersPerPost] = useState("500");
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
        body: JSON.stringify({ postUrls, includeKeywords, excludeKeywords, suppressionUrls, maxEngagersPerPost }),
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
      <div className="card" style={{ maxWidth: 820, margin: "60px auto" }}>
        <h1>LinkedIn Lead Finder</h1>
        <p className="muted">Paste one or more LinkedIn post URLs. Find commenters and publicly visible reactors, deduplicate them, and keep only people matching your job-title ICP.</p>

        <form onSubmit={submit}>
          <label>LinkedIn Post URLs</label>
          <textarea required value={postUrls} onChange={(e) => setPostUrls(e.target.value)} placeholder="One URL per line\nhttps://www.linkedin.com/posts/..." rows={5} />

          <label>Job Title Include Keywords</label>
          <textarea value={includeKeywords} onChange={(e) => setIncludeKeywords(e.target.value)} placeholder="founder, growth, marketing" rows={3} />

          <label>Job Title Exclude Keywords</label>
          <textarea value={excludeKeywords} onChange={(e) => setExcludeKeywords(e.target.value)} placeholder="student, intern" rows={2} />

          <label>Suppression List <span className="muted">(optional)</span></label>
          <textarea value={suppressionUrls} onChange={(e) => setSuppressionUrls(e.target.value)} placeholder="LinkedIn profile URLs already contacted, one per line" rows={3} />

          <label>Max Engagers Per Post</label>
          <input type="number" min={1} max={5000} value={maxEngagersPerPost} onChange={(e) => setMaxEngagersPerPost(e.target.value)} />

          <div style={{ marginTop: 20 }}><button disabled={loading}>{loading ? "Starting..." : "Find Leads"}</button></div>
          {error && <div className="error">{error}</div>}
        </form>

        <div className="notice">
          Output is limited to name, headline/job title, profile URL, and the engagement signal (comment/reaction). No email or phone enrichment is included.
        </div>
        <div className="notice">
          This MVP uses normal browser-visible behavior only. It does not bypass LinkedIn login, CAPTCHA, anti-bot systems, rate limits, or access controls.
        </div>
      </div>
    </main>
  );
}
