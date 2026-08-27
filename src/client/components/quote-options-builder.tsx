import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { QuoteOptionCard } from "./quote-option-card";
import { Plus, Send, Copy, RefreshCw, FileText } from "lucide-preact";
import type { QuoteOption, QuoteShareLink, OptionTier } from "../types";

const TIER_LABELS: Record<string, string> = { GOOD: "Good", BETTER: "Better", BEST: "Best", CUSTOM: "Custom" };
const SHARE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending", sent: "Sent", viewed: "Viewed", selected: "Selected", expired: "Expired", cancelled: "Cancelled",
};

/**
 * Phase 18 — Good/Better/Best Estimate builder, embedded in quote-detail.tsx
 * (Section 43/44 — Admin full access, Dispatcher the same minus cost, both
 * via the same canManageQuotes-gated API this already reuses; the
 * component itself never checks role — it just renders whatever the server
 * response contains, same "server strips, client renders what's present"
 * discipline as the rest of this codebase). Self-contained (own fetch, not
 * threaded through quote-detail.tsx's own state) — same precedent as
 * RelatedContracts.
 */
export function QuoteOptionsBuilder({ quoteId, isDraft, quoteStatus, acceptedOptionId }: {
  quoteId: number; isDraft: boolean; quoteStatus: string; acceptedOptionId: number | null;
}) {
  const [options, setOptions] = useState<QuoteOption[]>([]);
  const [shareLinks, setShareLinks] = useState<QuoteShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [freshLink, setFreshLink] = useState<{ url: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [resendingId, setResendingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [optRes, linkRes] = await Promise.all([
        api<{ options: QuoteOption[] }>("GET", `/api/quotes/${quoteId}/options`),
        api<{ links: QuoteShareLink[] }>("GET", `/api/quotes/${quoteId}/share-links`),
      ]);
      setOptions(optRes.options);
      setShareLinks(linkRes.links);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => { load(); }, [load]);

  const addOption = async (tier: OptionTier) => {
    setError(null);
    try {
      await api("POST", `/api/quotes/${quoteId}/options`, { tier, name: `${TIER_LABELS[tier]} Option` });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const sendEstimate = async () => {
    setSending(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api<{ token: string }>("POST", `/api/quotes/${quoteId}/share-links`, {});
      setFreshLink({ url: `${window.location.origin}/estimate/${res.token}`, label: "Estimate link" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const resend = async (linkId: number) => {
    setResendingId(linkId);
    setError(null);
    setCopied(false);
    try {
      const res = await api<{ token: string }>("POST", `/api/quotes/${quoteId}/share-links/${linkId}/resend`, {});
      setFreshLink({ url: `${window.location.origin}/estimate/${res.token}`, label: "New estimate link" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResendingId(null);
    }
  };

  const copyLink = async () => {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink.url);
      setCopied(true);
    } catch {
      // Clipboard API can be unavailable (older browser, non-HTTPS
      // context) — the raw link is already visible on screen, so the
      // staff member can still select-and-copy it manually.
    }
  };

  if (loading) return <div class="detail-section"><h3>Good / Better / Best Options</h3><p class="text-muted">Loading...</p></div>;

  return (
    <div class="detail-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>Good / Better / Best Options</h3>
        {options.length > 0 && (
          <button class="btn btn-sm" onClick={() => window.open(`/api/quotes/${quoteId}/estimate-pdf`, "_blank", "noopener,noreferrer")}>
            <FileText size={14} /> Preview PDF
          </button>
        )}
      </div>
      {error && <div class="inline-error" style={{ marginBottom: 10 }}>{error}</div>}

      {options.length === 0 && !isDraft ? null : (
        <div class="card" style={{ marginBottom: 16 }}>
          {options.length === 0 ? (
            <div class="empty-state">
              <p>No options yet</p>
              <p class="text-muted">Add a Good, Better, or Best option to build a comparison estimate for this customer.</p>
            </div>
          ) : null}
          {isDraft && (
            <div class="action-btns" style={{ padding: options.length === 0 ? "0 0 16px" : 0 }}>
              <button class="btn btn-sm" onClick={() => addOption("GOOD")}><Plus size={14} /> Good</button>
              <button class="btn btn-sm" onClick={() => addOption("BETTER")}><Plus size={14} /> Better</button>
              <button class="btn btn-sm" onClick={() => addOption("BEST")}><Plus size={14} /> Best</button>
              <button class="btn btn-sm" onClick={() => addOption("CUSTOM")}><Plus size={14} /> Custom</button>
            </div>
          )}
        </div>
      )}

      {options.length > 0 && (
        <div class="quote-options-list">
          {options.map((option) => (
            <div key={option.id} style={{ position: "relative" }}>
              {acceptedOptionId === option.id && (
                <div class="status-badge" style={{ background: "#16a34a14", color: "#16a34a", borderColor: "#16a34a30", marginBottom: 8 }}>
                  <span class="status-dot" style={{ background: "#16a34a" }} /> Customer selected this option
                </div>
              )}
              <QuoteOptionCard quoteId={quoteId} option={option} isDraft={isDraft} onChanged={load} />
            </div>
          ))}
        </div>
      )}

      {options.length > 0 && quoteStatus !== "accepted" && (
        <div class="card" style={{ marginTop: 16, padding: 16 }}>
          <div class="action-btns" style={{ marginBottom: freshLink ? 12 : 0 }}>
            <button class="btn btn-primary btn-sm" disabled={sending} onClick={sendEstimate}>
              <Send size={14} /> {isDraft ? "Send Estimate" : "Generate New Link"}
            </button>
          </div>
          {freshLink && (
            <div class="quote-share-link-box">
              <span class="text-muted" style={{ fontSize: 12 }}>{freshLink.label} (shown once — copy it now):</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                <code class="identifier" style={{ wordBreak: "break-all" }}>{freshLink.url}</code>
                <button type="button" class="btn-icon" onClick={copyLink} title="Copy link"><Copy size={14} /></button>
                {copied && <span class="text-muted" style={{ fontSize: 12 }}>Copied!</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {shareLinks.length > 0 && (
        <div class="table-wrap" style={{ marginTop: 16 }}>
          <table class="table">
            <thead><tr><th>Status</th><th>Expires</th><th>Selected By</th><th>Selected At</th>{isDraft === false && <th></th>}</tr></thead>
            <tbody>
              {shareLinks.map((link) => (
                <tr key={link.id} class="table-row">
                  <td class="text-muted">{SHARE_STATUS_LABELS[link.status] || link.status}</td>
                  <td class="text-muted">{link.expires_at.slice(0, 10)}</td>
                  <td class="text-muted">{link.selector_name || "—"}</td>
                  <td class="text-muted">{link.selected_at ? link.selected_at.slice(0, 16).replace("T", " ") : "—"}</td>
                  {(link.status === "sent" || link.status === "viewed") && (
                    <td>
                      <button class="btn-icon" title="Resend (issues a new link, cancels this one)" disabled={resendingId === link.id} onClick={() => resend(link.id)}>
                        <RefreshCw size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
