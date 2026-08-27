import { useEffect, useState } from "preact/hooks";
import { formatCents } from "../money";
import { CheckCircle2, FileX, Star, Sparkles } from "lucide-preact";
import type { PublicQuoteView, PublicQuoteOption } from "../types";

const TIER_LABELS: Record<string, string> = { GOOD: "Good", BETTER: "Better", BEST: "Best", CUSTOM: "Option" };

/**
 * Phase 18 — the ONE page a customer sees to compare Good/Better/Best
 * options and choose one (Section 42/68). Standalone, same precedent as
 * sign-contract.tsx/public-pay.tsx: rendered by main.tsx BEFORE
 * AuthProvider mounts, no session, no sidebar. The token in the URL is the
 * entire authorization boundary — every request goes through the public
 * `/api/public/quotes/estimate/{token}` routes with no Authorization
 * header. Never renders cost/margin/internal notes — the server never
 * sends them to this page in the first place (see quote-options.ts's
 * `toPublicOption`), so there is nothing here to accidentally leak.
 */
export function EstimateSelection({ token }: { token: string }) {
  const [view, setView] = useState<PublicQuoteView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectorName, setSelectorName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSelectedId, setJustSelectedId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const r = await fetch(`/api/public/quotes/estimate/${encodeURIComponent(token)}`);
      if (!r.ok) { setNotFound(true); return; }
      const data = await r.json() as { view: PublicQuoteView };
      setView(data.view);
      if (data.view.already_selected_option_id) setSelectedId(data.view.already_selected_option_id);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmSelection = async () => {
    if (selectedId === null || !selectorName.trim()) { setError("Please enter your name to confirm."); return; }
    setConfirming(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/quotes/estimate/${encodeURIComponent(token)}/select`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ option_id: selectedId, selector_name: selectorName.trim() }),
      });
      const body = await r.json() as { error?: string };
      if (!r.ok) throw new Error(body.error || "Could not record your selection — please try again.");
      setJustSelectedId(selectedId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  if (loading) return <div class="estimate-page"><div class="loading-text">Loading...</div></div>;

  if (notFound) {
    return (
      <div class="estimate-page">
        <div class="estimate-status-card">
          <FileX size={32} style={{ color: "#dc2626" }} />
          <h1 class="auth-title">Link invalid or expired</h1>
          <p class="auth-subtitle">This estimate link is no longer valid. Please contact us for a new one.</p>
        </div>
      </div>
    );
  }

  if (!view) return null;

  const alreadySelectedId = justSelectedId ?? view.already_selected_option_id;
  if (alreadySelectedId) {
    const chosen = view.options.find((o) => o.id === alreadySelectedId);
    return (
      <div class="estimate-page">
        <div class="estimate-status-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Thank you!</h1>
          <p class="auth-subtitle">
            You selected <strong>{chosen ? `${TIER_LABELS[chosen.tier]} — ${chosen.name}` : "your option"}</strong> for estimate {view.quote_identifier}.
            {chosen && <> Total: {formatCents(chosen.total_cents)}.</>} We'll be in touch shortly.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="estimate-page">
      <div class="estimate-wrap">
        <div class="estimate-header">
          <h1 class="auth-title">Choose your option</h1>
          <p class="auth-subtitle">Estimate {view.quote_identifier} for {view.customer_name}</p>
        </div>

        {error && <div class="auth-error" style={{ maxWidth: 480, margin: "0 auto 16px" }}>{error}</div>}

        <div class="estimate-options-grid">
          {view.options.map((option) => (
            <OptionCard
              key={option.id}
              option={option}
              selected={selectedId === option.id}
              onSelect={() => setSelectedId(option.id)}
            />
          ))}
        </div>

        {selectedId !== null && (
          <div class="estimate-confirm-bar">
            <input
              type="text"
              class="estimate-name-input"
              placeholder="Your full name"
              aria-label="Your full name"
              value={selectorName}
              onInput={(e) => setSelectorName((e.target as HTMLInputElement).value)}
            />
            <button type="button" class="btn btn-primary" disabled={confirming} onClick={confirmSelection}>
              {confirming ? "Confirming..." : "Confirm my selection"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionCard({ option, selected, onSelect }: { option: PublicQuoteOption; selected: boolean; onSelect: () => void }) {
  return (
    <div class={`estimate-option-card ${selected ? "selected" : ""} ${option.recommended ? "recommended" : ""}`}>
      {option.recommended && (
        <div class="estimate-recommended-badge"><Star size={12} /> Recommended</div>
      )}
      <div class="estimate-option-tier">{TIER_LABELS[option.tier] || option.tier}</div>
      <h2 class="estimate-option-name">{option.name || TIER_LABELS[option.tier]}</h2>
      {option.headline && <p class="estimate-option-headline">{option.headline}</p>}
      {option.description && <p class="text-muted" style={{ fontSize: 13 }}>{option.description}</p>}

      {option.highlights.length > 0 && (
        <ul class="estimate-highlights">
          {option.highlights.map((h) => (
            <li key={h}><Sparkles size={12} /> {h}</li>
          ))}
        </ul>
      )}

      <ul class="estimate-line-items">
        {option.line_items.map((line) => (
          <li key={line.id}>
            <span>{line.description || "Item"}{line.quantity !== 1 ? ` × ${line.quantity}` : ""}</span>
          </li>
        ))}
      </ul>

      <div class="estimate-option-totals">
        {option.tax_amount_cents > 0 && (
          <>
            <div class="estimate-total-row text-muted"><span>Subtotal</span><span>{formatCents(option.subtotal_cents)}</span></div>
            <div class="estimate-total-row text-muted"><span>Tax</span><span>{formatCents(option.tax_amount_cents)}</span></div>
          </>
        )}
        <div class="estimate-total-row estimate-total-main"><span>Total</span><span>{formatCents(option.total_cents)}</span></div>
      </div>

      <button type="button" class={`btn btn-block ${selected ? "btn-primary" : ""}`} onClick={onSelect}>
        {selected ? "Selected" : "Select this option"}
      </button>
    </div>
  );
}
