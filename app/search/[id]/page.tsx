"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { matchesJobTitle } from "@/lib/title-filter";

type Result = {
  id: string;
  name: string;
  headline: string | null;
  jobTitle: string | null;
  company: string | null;
  linkedinUrl: string;
  engagement: string;
  reactionType: string | null;
  commentText: string | null;
  engagedAt: string | null;
  postUrl: string | null;
};

type Search = {
  id: string;
  postUrl: string;
  postUrls: string[];
  status: string;
  sessionStatus: string;
  error: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  suppressionCount: number;
  maxEngagersPerPost: number;
  totalEngagements: number;
  uniquePeople: number;
  results: Result[];
};

export default function SearchPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Search | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch(`/api/search/${params.id}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) return setError(json.error || "Failed to load search");
    setData(json);
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [params.id]);

  const matched = useMemo(() => data?.results.filter((r) => matchesJobTitle(r.jobTitle || r.headline, data.includeKeywords, data.excludeKeywords)) ?? [], [data]);

  if (error) return <main className="container"><div className="card"><div className="error">{error}</div></div></main>;
  if (!data) return <main className="container"><div className="card">Loading...</div></main>;

  const sessionLabel = data.sessionStatus === "SIGNED_IN" ? "LinkedIn session: SIGNED IN" : data.sessionStatus === "SIGNED_OUT" ? "LinkedIn session: SIGNED OUT" : "LinkedIn session: UNKNOWN";

  return (
    <main className="container">
      <div className="toolbar">
        <div>
          <h1>Lead Results</h1>
          <p className="muted">{data.postUrls.length} post(s) · deduplicated by LinkedIn profile URL</p>
        </div>
        <a className="button" href={`/api/search/${data.id}/export`}>Export CSV</a>
      </div>

      <div className="stats">
        <div className="stat">Status: <strong>{data.status}</strong></div>
        <div className="stat">{sessionLabel}</div>
        <div className="stat">Posts: <strong>{data.postUrls.length}</strong></div>
        <div className="stat">Engagements: <strong>{data.totalEngagements}</strong></div>
        <div className="stat">Unique people: <strong>{data.uniquePeople}</strong></div>
        <div className="stat">ICP matches: <strong>{matched.length}</strong></div>
      </div>

      {data.sessionStatus === "SIGNED_OUT" && (
        <div className="notice">LinkedIn is signed out in the connected Windows Chrome Profile. Open that Chrome window, log in normally, keep it open, and run the search again.</div>
      )}
      {data.sessionStatus === "SIGNED_IN" && (
        <div className="notice">LinkedIn session detected. The worker is reusing the connected Windows Chrome Profile.</div>
      )}
      {data.error && <div className="notice">{data.error}</div>}
      <div className="notice">
        Include: {data.includeKeywords.join(", ") || "none"} · Exclude: {data.excludeKeywords.join(", ") || "none"} · Suppressed: {data.suppressionCount}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Headline</th><th>Engagement</th><th>Comment / Signal</th><th>Post</th><th>LinkedIn</th></tr></thead>
            <tbody>
              {matched.map((lead) => (
                <tr key={lead.id}>
                  <td>{lead.name}</td>
                  <td>{lead.headline || "—"}</td>
                  <td><span className="badge">{lead.engagement}{lead.reactionType ? ` · ${lead.reactionType}` : ""}</span></td>
                  <td>{lead.commentText || lead.reactionType || "—"}</td>
                  <td>{lead.postUrl ? <a href={lead.postUrl} target="_blank" rel="noreferrer">Post</a> : "—"}</td>
                  <td><a href={lead.linkedinUrl} target="_blank" rel="noreferrer">View</a></td>
                </tr>
              ))}
              {data.status === "COMPLETED" && matched.length === 0 && <tr><td colSpan={6}>No matching leads found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
