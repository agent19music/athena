"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { ArrowRight, ChatTeardropText, ClockCounterClockwise, Plus, Trash, X } from "@phosphor-icons/react";
import DocumentCard from "../../components/chat/DocumentCard";
import StaffCard from "../../components/chat/StaffCard";
import DashboardShell from "../../components/DashboardShell";
import { ConfirmDialog } from "../../components/athena/ConfirmDialog";
import { Toast } from "../../components/Toast";


const API_URL = "/api";

type ChatResponse = {
  answer: string;
  type: "document" | "staff_fallback";
  source_title?: string;
  source_doc_id?: string;
  source_type?: "google_docs" | "notion" | "tally" | "upload" | "mock";
  source_excerpt?: string;
  staff_name?: string;
  staff_email?: string;
  staff_domain?: string;
  staff_title?: string;
  staff_department?: string;
  similarity_score?: number;
  degraded?: boolean;
};

type Message =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; data: ChatResponse };

type ConversationSummary = { id: string; title: string; updated_at: string };

// While a request is in flight, cycle the orb through phases so it reads as
// active work ("searching your docs" → "composing an answer") rather than a
// static spinner. The label advances on a timer and holds on the last phase.
const THINKING_PHASES = [
  { state: "searching", label: "Searching your docs" },
  { state: "composing", label: "Composing an answer" },
] as const;

function ThinkingIndicator() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (phase >= THINKING_PHASES.length - 1) return;
    const t = setTimeout(() => setPhase((p) => p + 1), 1100);
    return () => clearTimeout(t);
  }, [phase]);

  const { state, label } = THINKING_PHASES[phase];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
      <ThinkingOrb state={state} size={20} speed={0.9} />
      <span style={{ fontSize: 14, color: "var(--a-muted)" }}>
        {label}…
      </span>
    </div>
  );
}

// Bucket a conversation by how recently it was last active.
function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

// Rebuild the in-memory message list from a stored thread transcript.
type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
};

function fromStored(m: StoredMessage): Message {
  if (m.role === "user") return { id: m.id, role: "user", text: m.content };
  const meta = m.metadata ?? {};
  return {
    id: m.id,
    role: "assistant",
    data: { answer: m.content, type: (meta.type as ChatResponse["type"]) ?? "document", ...meta },
  };
}

export default function ChatClient({
  suggestions = [],
  sourceCount = null,
  initialQuery = null,
}: {
  suggestions?: string[];
  sourceCount?: number | null;
  initialQuery?: string | null;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // The history column stays hidden until the first fetch settles, so a
  // person with no conversations never sees an empty list flash in.
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialSent = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/conversations`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {
      /* non-fatal — sidebar just stays as-is */
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setInput("");
    setMobileHistoryOpen(false);
    inputRef.current?.focus();
  }

  async function openConversation(id: string) {
    setMobileHistoryOpen(false);
    if (id === activeId) return;
    setActiveId(id);
    setLoadingThread(true);
    setMessages([]);
    try {
      const res = await fetch(`${API_URL}/conversations/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && Array.isArray(data.messages)) {
        setMessages(data.messages.map(fromStored));
      }
    } catch {
      /* leave empty on failure */
    } finally {
      setLoadingThread(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setDeleting(true);
    try {
      const res = await fetch(`${API_URL}/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setConversations((prev) => prev.filter((c) => c.id !== id));
      // Deleting the last one removes the history column; don't leave the
      // mobile drawer flagged open for when it comes back.
      if (conversations.every((c) => c.id === id)) setMobileHistoryOpen(false);
      if (id === activeId) newChat();
    } catch {
      setToast("Couldn't delete that conversation. Try again.");
      refreshConversations();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  async function submit(query: string) {
    const q = query.trim();
    if (!q || loading) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, conversation_id: activeId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (data.conversation_id && data.conversation_id !== activeId) {
        setActiveId(data.conversation_id);
      }
      const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", data };
      setMessages((prev) => [...prev, assistantMsg]);
      refreshConversations();

      if (data.degraded) {
        setToast("Athena's AI is at capacity right now, so this answer shows the raw source text instead of a summary. Try again shortly.");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        data: { answer: `Request failed: ${detail}`, type: "staff_fallback" },
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }

  // Questions asked from the Overview "Ask Athena" card arrive as ?q=
  useEffect(() => {
    if (initialQuery && !initialSent.current) {
      initialSent.current = true;
      submit(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const isEmpty = messages.length === 0 && !loadingThread && !loading;
  // No history yet: the page is only the centred empty state and composer.
  const hasHistory = conversationsLoaded && conversations.length > 0;
  const showThreadHead = hasHistory || !!activeId || !isEmpty;
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const title = active?.title ?? (activeId ? (messages.find((m) => m.role === "user") as { text?: string } | undefined)?.text ?? "Conversation" : "New chat");

  // Group conversations for the sidebar (list is already newest-first).
  const grouped = new Map<string, ConversationSummary[]>();
  for (const c of conversations) {
    const label = groupLabel(c.updated_at);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(c);
  }

  return (
    <DashboardShell>
      <div className="a-chat">
        {hasHistory && (
          <aside className={`a-convos${mobileHistoryOpen ? " open" : ""}`} aria-label="Conversations">
            <div className="a-convos-head" style={{ gap: 8 }}>
              <button type="button" className="a-btn a-btn-primary" style={{ flex: 1 }} onClick={newChat}>
                <Plus size={14} />
                New chat
              </button>
              {mobileHistoryOpen && (
                <button type="button" className="a-icon-btn" aria-label="Close history" onClick={() => setMobileHistoryOpen(false)}>
                  <X size={16} />
                </button>
              )}
            </div>
            <div className="a-convos-list">
              {GROUP_ORDER.filter((g) => grouped.has(g)).map((g) => (
                <div key={g} style={{ marginBottom: 18 }}>
                  <div className="a-group" style={{ margin: "6px 0" }}>{g}</div>
                  {grouped.get(g)!.map((c) => {
                    const isActive = c.id === activeId;
                    return (
                      <div
                        key={c.id}
                        className="a-convo"
                        aria-current={isActive}
                        role="button"
                        tabIndex={0}
                        onClick={() => openConversation(c.id)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openConversation(c.id); } }}
                      >
                        <span className="t">{c.title}</span>
                        <button
                          type="button"
                          className="a-icon-btn sm bare"
                          aria-label="Delete conversation"
                          onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
                        >
                          <Trash size={14} color="var(--a-danger)" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </aside>
        )}

        <section className="a-thread">
          {showThreadHead && (
            <div className="a-thread-head">
              <span className="a-ellipsis" style={{ fontSize: 14, minWidth: 0 }}>{title}</span>
              {active ? (
                <span style={{ fontSize: 12, color: "var(--a-muted)", flexShrink: 0 }}>{groupLabel(active.updated_at)}</span>
              ) : !activeId && typeof sourceCount === "number" && sourceCount > 0 ? (
                <span className="a-badge">{sourceCount} source{sourceCount === 1 ? "" : "s"} connected</span>
              ) : null}
              <span style={{ flex: 1 }} />
              {active && (
                <button type="button" className="a-btn a-btn-danger-quiet a-btn-sm" onClick={() => setPendingDelete(active)}>
                  <Trash size={14} />
                  Delete
                </button>
              )}
            </div>
          )}

          {showThreadHead && (
            <div className="a-thread-m-head">
              <button type="button" className="a-icon-btn sm bare" aria-label="Conversation history" onClick={() => setMobileHistoryOpen(true)}>
                <ClockCounterClockwise size={18} color="var(--a-ink)" />
              </button>
              <span className="a-ellipsis" style={{ flex: 1, fontSize: 14 }}>{title}</span>
              {active && (
                <button type="button" className="a-icon-btn sm bare" aria-label="Delete conversation" onClick={() => setPendingDelete(active)}>
                  <Trash size={16} color="var(--a-danger)" />
                </button>
              )}
              <button type="button" className="a-icon-btn sm bare" aria-label="New chat" onClick={newChat}>
                <Plus size={18} color="var(--a-ink)" />
              </button>
            </div>
          )}

          <div className={`a-thread-body${isEmpty ? " empty" : ""}`}>
            {isEmpty ? (
              <div className="a-chat-empty">
                <div>
                  <div className="a-kicker" style={{ marginBottom: 12 }}>Ask Athena</div>
                  <h1 className="a-serif">What do you need to know?</h1>
                  <p>
                    {suggestions.length > 0
                      ? "These questions come from your connected docs and uploads."
                      : "Ask anything about how the team works."}
                  </p>
                </div>
                {suggestions.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                    {suggestions.map((s) => (
                      <button key={s} type="button" className="a-suggest" onClick={() => submit(s)}>
                        <ChatTeardropText size={16} color="var(--a-muted)" style={{ flexShrink: 0 }} />
                        <span>{s}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="a-thread-inner">
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div key={msg.id} style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
                      <div className="a-bubble">{msg.text}</div>
                    </div>
                  ) : (
                    <div key={msg.id} style={{ marginBottom: 28 }}>
                      {msg.data.type === "document" ? (
                        <DocumentCard
                          answer={msg.data.answer}
                          sourceTitle={msg.data.source_title}
                          sourceDocId={msg.data.source_doc_id}
                          sourceType={msg.data.source_type}
                          sourceExcerpt={msg.data.source_excerpt}
                          similarityScore={msg.data.similarity_score}
                        />
                      ) : (
                        <StaffCard
                          answer={msg.data.answer}
                          staffName={msg.data.staff_name}
                          staffEmail={msg.data.staff_email}
                          staffDomain={msg.data.staff_domain}
                          staffTitle={msg.data.staff_title}
                          staffDepartment={msg.data.staff_department}
                        />
                      )}
                    </div>
                  ),
                )}
                {(loading || loadingThread) && (
                  <div style={{ marginBottom: 24 }}>
                    <ThinkingIndicator />
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <div className="a-composer-bar">
            <form
              className="a-input a-composer"
              style={{ maxWidth: 720, margin: "0 auto" }}
              onSubmit={(e) => { e.preventDefault(); submit(input); }}
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={activeId && messages.length > 0 ? "Ask a follow-up" : "Ask anything about how we work"}
                disabled={loading}
                aria-label="Ask Athena"
              />
              <button type="submit" className="a-btn a-btn-primary" disabled={!input.trim() || loading}>
                Ask
                <ArrowRight size={14} />
              </button>
            </form>
            <p style={{ textAlign: "center", fontSize: 12, color: "var(--a-muted)", marginTop: 10 }}>
              Athena may be wrong. Always verify important information.
            </p>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        icon={<Trash size={18} />}
        title="Delete this conversation?"
        body={`"${pendingDelete?.title ?? "This conversation"}" and its answers will be removed from your history. This can't be undone.`}
        confirmLabel="Delete"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </DashboardShell>
  );
}
