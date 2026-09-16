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
};

type Search = {
  id: string;
  postUrl: string;
  status: string;
  error: string | null;
  warnings: string[];
  includeKeywords: string[];
  excludeKeywords: string[];
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
    if (!res.ok) {
      setError(json.error || "Failed to load search");
      return;
    }
    setData(json);
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [params.id]);

  const matched = useMemo(() => {
    if (!data) return [];
    return data.results.filter((r) =>
      matchesJobTitle(r.jobTitle || r.headline, data.includeKeywords, data.excludeKeywords)
    );
  }, [data]);

  if (error) return <main className="container"><div className="card"><div className="error">{error}</div></div></main>;
  if (!data) return <main className="container"><div className="card">Loading...</div></main>;

  return (
    <main className="container">
      <div className="toolbar">
        <div>
          <h1>Search Results</h1>
          <p className="muted">{data.postUrl}</p>
        </div>
        <a className="button" href={`/api/search/${data.id}/export`}>Export CSV</a>
      </div>

      <div className="stats">
        <div className="stat">Status: <strong>{data.status}</strong></div>
        <div className="stat">Engagements: <strong>{data.totalEngagements}</strong></div>
        <div className="stat">Unique people: <strong>{data.uniquePeople}</strong></div>
        <div className="stat">Matched leads: <strong>{matched.length}</strong></div>
      </div>

      {data.error && <div className="notice">{data.error}</div>}
      {data.warnings?.map((w, i) => <div className="notice" key={i}>{w}</div>)}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Job title</th>
                <th>Company</th>
                <th>Engagement</th>
                <th>Comment</th>
                <th>LinkedIn</th>
              </tr>
            </thead>
            <tbody>
              {matched.map((lead) => (
                <tr key={`${lead.id}-${lead.engagement}`}>
                  <td>{lead.name}</td>
                  <td>{lead.jobTitle || lead.headline || "—"}</td>
                  <td>{lead.company || "—"}</td>
                  <td>
                    <span className="badge">
                      {lead.engagement}
                      {lead.reactionType ? ` · ${lead.reactionType}` : ""}
                    </span>
                  </td>
                  <td>{lead.commentText || "—"}</td>
                  <td>
                    <a href={lead.linkedinUrl} target="_blank" rel="noreferrer">View</a>
                  </td>
                </tr>
              ))}
              {data.status === "COMPLETED" && matched.length === 0 && (
                <tr><td colSpan={6}>No matching leads found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
