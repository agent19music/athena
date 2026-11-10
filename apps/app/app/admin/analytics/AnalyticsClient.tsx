"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatTeardropText, CheckCircle, ClockCounterClockwise, Users } from "@phosphor-icons/react";
import { StatCard } from "@/components/athena/ui";
import { useWorkspaceSummary } from "@/components/athena/useWorkspaceSummary";

type Analytics = {
  total_questions: number;
  unanswered_count: number;
  active_threads: number;
  volume: { day: string; count: number }[];
  top_questions: { question: string; count: number }[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Backend days are calendar dates ("2026-11-05"); parse without a timezone
// shift so the axis never shows the previous day.
function parseDay(day: string): { m: number; d: number } {
  const [, m, d] = day.slice(0, 10).split("-").map(Number);
  return { m: (m || 1) - 1, d: d || 1 };
}

function axisLabel(day: string, i: number, prev?: string): string {
  const { m, d } = parseDay(day);
  if (i === 0 || (prev && parseDay(prev).m !== m)) return `${MONTHS[m]} ${d}`;
  return String(d);
}

function VolumeChart({ data }: { data: { day: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((n, d) => n + d.count, 0);
  const busiest = data.reduce<{ day: string; count: number } | null>((b, d) => (!b || d.count > b.count ? d : b), null);
  const busiestLabel = busiest && busiest.count > 0 ? (() => { const { m, d } = parseDay(busiest.day); return `${MONTHS[m]} ${d}`; })() : null;

  return (
    <div className="a-card a-chart">
      <div className="a-chart-head">
        <h2>Questions over the last 14 days</h2>
        <span>
          {total.toLocaleString()} question{total === 1 ? "" : "s"}
          {busiestLabel ? ` · busiest day ${busiestLabel}` : ""}
        </span>
      </div>
      {data.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--a-muted)" }}>No questions yet.</p>
      ) : (
        <>
          <div className="a-bars" role="img" aria-label={`Questions per day, ${total} total`}>
            {data.map((d) => (
              <div key={d.day} className="col" title={`${d.count} on ${d.day}`}>
                <span className="n">{d.count}</span>
                <div className="bar" style={{ ["--h" as string]: d.count / max }} />
              </div>
            ))}
          </div>
          <div className="a-bars-x">
            {data.map((d, i) => (
              <div key={d.day}>{axisLabel(d.day, i, data[i - 1]?.day)}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Module-level so it survives unmount/remount (tab switches, navigating away
// and back) — the client fetches once per session and later mounts render
// the cached cards immediately instead of showing "Loading…" again.
let analyticsCache: Analytics | null = null;

export default function AnalyticsClient() {
  const [data, setData] = useState<Analytics | null>(analyticsCache);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(analyticsCache === null);
  const summary = useWorkspaceSummary();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/analytics", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? json.detail ?? "Could not load analytics.");
        } else {
          analyticsCache = json;
          setData(json);
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const derived = useMemo(() => {
    if (!data) return null;
    const answered = data.total_questions - data.unanswered_count;
    const answerRate =
      data.total_questions > 0 ? Math.round((answered / data.total_questions) * 100) : 0;
    return { answered, answerRate };
  }, [data]);

  // Loading only blocks the first-ever fetch — once cached, stale cards stay
  // on screen while a fresh fetch resolves in the background.
  if (loading && !data) {
    return <p style={{ fontSize: 14, color: "var(--a-muted)" }}>Loading…</p>;
  }
  if (error && !data) {
    return <div className="a-notice err">{error}</div>;
  }
  if (!data || !derived) return null;

  const { answered, answerRate } = derived;
  const topMax = Math.max(1, ...data.top_questions.map((q) => q.count));

  return (
    <>
      <div className="a-stats" style={{ marginBottom: 24 }}>
        <StatCard icon={<ChatTeardropText size={16} />} value={data.total_questions.toLocaleString()} label="Questions asked" hint="All time" />
        <StatCard
          icon={<CheckCircle size={16} weight="fill" color="var(--a-status-ok)" />}
          value={`${answerRate}%`}
          label="Answered from docs"
          hint={`${answered.toLocaleString()} of ${data.total_questions.toLocaleString()} questions`}
        />
        <StatCard icon={<Users size={16} />} value={data.unanswered_count.toLocaleString()} label="Unanswered" hint="Suggested a teammate instead" />
        <StatCard
          icon={<ClockCounterClockwise size={16} />}
          value={data.active_threads.toLocaleString()}
          label="Conversations"
          hint={summary ? `Across ${summary.members} member${summary.members === 1 ? "" : "s"}` : undefined}
        />
      </div>

      <VolumeChart data={data.volume} />

      <div className="a-sec-t"><h2>Top questions</h2></div>
      <div className="a-card a-clip">
        {data.top_questions.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--a-muted)", padding: "20px" }}>No questions yet.</p>
        ) : (
          <>
            <div className="a-topq head">
              <span>#</span>
              <span>Question</span>
              <span className="a-only-d">Compared with the top question</span>
              <span style={{ textAlign: "right" }}>Asked</span>
            </div>
            {data.top_questions.map((q, i) => (
              <div key={i} className="a-topq">
                <span style={{ fontSize: 12, color: "var(--a-muted)" }} className="a-num">{i + 1}</span>
                <span style={{ fontSize: 14, minWidth: 0, overflowWrap: "anywhere" }}>{q.question}</span>
                <div className="a-bar a-only-d"><span style={{ width: `${(q.count / topMax) * 100}%` }} /></div>
                <span className="a-num" style={{ textAlign: "right", fontSize: 13 }}>{q.count}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
