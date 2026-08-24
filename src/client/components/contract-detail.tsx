import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { CONTRACT_STATUS_LABELS, SIGNER_ROLES, SIGNER_ROLE_LABELS } from "../contract-status";
import { ConfirmDialog } from "./confirm-dialog";
import { ArrowLeft, Trash2, Plus, X, Copy } from "lucide-preact";
import type { Contract, ContractVersion, ContractSigner, SignatureRequest, ContractStatusHistoryRow, EvidencePackage, SignerRole } from "../types";

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280", sent: "#3b82f6", partially_signed: "#ca8a04", signed: "#16a34a",
  declined: "#dc2626", expired: "#9ca3af", cancelled: "#9ca3af", voided: "#9ca3af",
};

const emptySignerDraft = { name: "", email: "", phone: "", role: "customer" as SignerRole };

/**
 * Phase 13 — Contract detail. Self-contained (own fetch, not AppContext) —
 * same reasoning as QuoteDetail/LeadDetail: irrelevant to the technician
 * role. All version content (title/body/dates) is editable only while
 * status='draft' — the server enforces this; the UI mirrors it by hiding
 * edit affordances once sent, matching the versioning model's "sent is
 * historically stable" requirement (Section 11/38).
 */
export function ContractDetail({ id, navigate }: { id: number; navigate: (to: string) => void }) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [version, setVersion] = useState<ContractVersion | null>(null);
  const [signers, setSigners] = useState<ContractSigner[]>([]);
  const [requests, setRequests] = useState<SignatureRequest[]>([]);
  const [history, setHistory] = useState<ContractStatusHistoryRow[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [canCreateRevision, setCanCreateRevision] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState({ title: "", body: "", effective_date: "", expires_at: "" });
  const [savingMeta, setSavingMeta] = useState(false);

  const [showAddSigner, setShowAddSigner] = useState(false);
  const [signerDraft, setSignerDraft] = useState(emptySignerDraft);
  const [savingSigner, setSavingSigner] = useState(false);
  const [pendingDeleteSigner, setPendingDeleteSigner] = useState<number | null>(null);

  const [pendingSend, setPendingSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [freshLinks, setFreshLinks] = useState<{ signer_id: number; signer_name: string; token: string }[]>([]);

  const [pendingTransition, setPendingTransition] = useState<string | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [transitioning, setTransitioning] = useState(false);

  const [pendingRevision, setPendingRevision] = useState(false);
  const [creatingRevision, setCreatingRevision] = useState(false);

  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [pendingCancelRequest, setPendingCancelRequest] = useState<number | null>(null);
  const [cancellingRequest, setCancellingRequest] = useState(false);
  const [resendingRequestId, setResendingRequestId] = useState<number | null>(null);
  const [resentToken, setResentToken] = useState<{ requestId: number; token: string } | null>(null);

  const [evidence, setEvidence] = useState<EvidencePackage | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, signersRes, requestsRes, transitions, historyRes] = await Promise.all([
        api<{ contract: Contract; version: ContractVersion | null }>("GET", `/api/contracts/${id}`),
        api<{ signers: ContractSigner[] }>("GET", `/api/contracts/${id}/signers`),
        api<{ requests: SignatureRequest[] }>("GET", `/api/contracts/${id}/signature-requests`),
        api<{ allowed: string[]; can_create_revision: boolean }>("GET", `/api/contracts/${id}/transitions`),
        api<{ history: ContractStatusHistoryRow[] }>("GET", `/api/contracts/${id}/status-history`),
      ]);
      setContract(detail.contract);
      setVersion(detail.version);
      setSigners(signersRes.signers);
      setRequests(requestsRes.requests);
      setAllowed(transitions.allowed);
      setCanCreateRevision(transitions.can_create_revision);
      setHistory(historyRes.history);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div class="page loading-text">Loading...</div>;

  if (loadError || !contract) {
    return (
      <div class="page">
        <button class="btn btn-back" onClick={() => navigate("/contracts")}><ArrowLeft size={16} /> Back</button>
        <div class="inline-error" style={{ marginTop: 16 }}>{loadError || "This contract could not be found."}</div>
      </div>
    );
  }

  const isDraft = contract.status === "draft";
  const color = STATUS_COLORS[contract.status] || "#6b7280";
  let commercial: { line_items?: { description: string; quantity: number; unit_price_cents: number; total_cents: number }[]; total_cents?: number } = {};
  try { if (version?.commercial_snapshot) commercial = JSON.parse(version.commercial_snapshot); } catch { /* display-only, never fatal */ }

  const startEditMeta = () => {
    if (!version) return;
    setMetaDraft({ title: version.title, body: version.body, effective_date: version.effective_date ?? "", expires_at: version.expires_at ?? "" });
    setEditingMeta(true);
  };

  const saveMeta = async () => {
    setSavingMeta(true);
    setActionError(null);
    try {
      await api("PUT", `/api/contracts/${id}/version`, {
        title: metaDraft.title, body: metaDraft.body,
        effective_date: metaDraft.effective_date || null, expires_at: metaDraft.expires_at || null,
      });
      setEditingMeta(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingMeta(false);
    }
  };

  const submitAddSigner = async () => {
    setSavingSigner(true);
    setActionError(null);
    try {
      await api("POST", `/api/contracts/${id}/signers`, signerDraft);
      setShowAddSigner(false);
      setSignerDraft(emptySignerDraft);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingSigner(false);
    }
  };

  const confirmDeleteSigner = async () => {
    if (pendingDeleteSigner === null) return;
    setSavingSigner(true);
    try {
      await api("DELETE", `/api/contracts/${id}/signers/${pendingDeleteSigner}`);
      setPendingDeleteSigner(null);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingSigner(false);
    }
  };

  const confirmSend = async () => {
    setSending(true);
    setActionError(null);
    try {
      const res = await api<{ contract: Contract; signing_links: { signer_id: number; signer_name: string; token: string }[] }>("POST", `/api/contracts/${id}/send`, {});
      setFreshLinks(res.signing_links);
      setPendingSend(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const confirmTransition = async () => {
    if (!pendingTransition) return;
    setTransitioning(true);
    setActionError(null);
    try {
      await api("POST", `/api/contracts/${id}/transition`, { to_status: pendingTransition, reason: transitionReason || undefined });
      setPendingTransition(null);
      setTransitionReason("");
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setTransitioning(false);
    }
  };

  const confirmRevision = async () => {
    setCreatingRevision(true);
    setActionError(null);
    try {
      await api("POST", `/api/contracts/${id}/revisions`, {});
      setPendingRevision(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await api("DELETE", `/api/contracts/${id}`);
      navigate("/contracts");
    } catch (err) {
      setActionError((err as Error).message);
      setDeleting(false);
    }
  };

  const confirmCancelRequest = async () => {
    if (pendingCancelRequest === null) return;
    setCancellingRequest(true);
    try {
      await api("POST", `/api/contracts/${id}/signature-requests/${pendingCancelRequest}/cancel`, {});
      setPendingCancelRequest(null);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCancellingRequest(false);
    }
  };

  const resendRequest = async (requestId: number) => {
    setResendingRequestId(requestId);
    setActionError(null);
    try {
      const res = await api<{ token: string }>("POST", `/api/contracts/${id}/signature-requests/${requestId}/resend`, {});
      setResentToken({ requestId, token: res.token });
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setResendingRequestId(null);
    }
  };

  const loadEvidence = async () => {
    setShowEvidence(true);
    try {
      const res = await api<{ evidence: EvidencePackage }>("GET", `/api/contracts/${id}/evidence`);
      setEvidence(res.evidence);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const signingUrlFor = (token: string) => `${window.location.origin}/sign/${token}`;

  const signerById = new Map(signers.map((s) => [s.id, s]));

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/contracts")}><ArrowLeft size={16} /> Back</button>
        <div class="page-header-right">
          {isDraft && history.length === 0 && (
            <button class="btn btn-danger" onClick={() => setPendingDelete(true)}><Trash2 size={14} /> Delete</button>
          )}
        </div>
      </div>

      {actionError && <div class="inline-error" style={{ marginBottom: 12 }}>{actionError}</div>}

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{contract.identifier}</span>
            <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
              <span class="status-dot" style={{ background: color }} />
              {CONTRACT_STATUS_LABELS[contract.status] || contract.status}
            </span>
          </div>
          <h2 class="detail-customer-name">{contract.customer_name || "—"}</h2>

          <div class="detail-meta-grid">
            <div class="detail-meta-item">
              <span class="detail-meta-label">Source Quote</span>
              <span class="identifier">{contract.quote_identifier || "—"}</span>
            </div>
            {version?.effective_date && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Effective Date</span>
                <span>{version.effective_date}</span>
              </div>
            )}
            {contract.voided_at && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Voided</span>
                <span>{new Date(contract.voided_at).toLocaleDateString()} — {contract.void_reason}</span>
              </div>
            )}
          </div>

          {commercial.line_items && commercial.line_items.length > 0 && (
            <div class="detail-section">
              <h3>Commercial Terms (from accepted quote)</h3>
              <div class="card">
                <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Description</th><th>Qty</th><th class="text-right">Amount</th></tr></thead>
                  <tbody>
                    {commercial.line_items.map((li, i) => (
                      <tr key={i} class="table-row">
                        <td>{li.description}</td>
                        <td>{li.quantity}</td>
                        <td class="text-right">{formatCents(li.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={2} class="text-right text-bold">Total</td><td class="text-right text-bold">{formatCents(commercial.total_cents ?? 0)}</td></tr>
                  </tfoot>
                </table>
                </div>
              </div>
            </div>
          )}

          <div class="detail-section">
            <h3>Agreement Text</h3>
            {editingMeta ? (
              <div class="form-grid" style={{ padding: 0 }}>
                <div class="form-group full-width">
                  <label>Title</label>
                  <input type="text" value={metaDraft.title} onInput={(e) => setMetaDraft({ ...metaDraft, title: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Effective Date</label>
                  <input type="date" value={metaDraft.effective_date} onChange={(e) => setMetaDraft({ ...metaDraft, effective_date: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Expires</label>
                  <input type="date" value={metaDraft.expires_at} onChange={(e) => setMetaDraft({ ...metaDraft, expires_at: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group full-width">
                  <label>Body</label>
                  <textarea rows={8} value={metaDraft.body} onInput={(e) => setMetaDraft({ ...metaDraft, body: (e.target as HTMLTextAreaElement).value })} />
                </div>
                <div class="form-group full-width" style={{ display: "flex", gap: 8 }}>
                  <button class="btn btn-sm" onClick={() => setEditingMeta(false)} disabled={savingMeta}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={saveMeta} disabled={savingMeta}>{savingMeta ? "Saving..." : "Save"}</button>
                </div>
              </div>
            ) : (
              <>
                <p class="detail-notes" style={{ whiteSpace: "pre-wrap" }}>{version?.body || <span class="text-muted">No agreement text yet</span>}</p>
                {isDraft && <button class="btn btn-sm" onClick={startEditMeta}>Edit</button>}
              </>
            )}
          </div>

          <div class="detail-section">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3>Signers ({signers.length})</h3>
              {isDraft && !showAddSigner && (
                <button class="btn btn-sm" onClick={() => { setShowAddSigner(true); setSignerDraft(emptySignerDraft); }}><Plus size={14} /> Add Signer</button>
              )}
            </div>
            {showAddSigner && (
              <div class="card" style={{ padding: 12, marginBottom: 12 }}>
                <div class="form-grid">
                  <div class="form-group">
                    <label>Name</label>
                    <input type="text" value={signerDraft.name} onInput={(e) => setSignerDraft({ ...signerDraft, name: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Email</label>
                    <input type="email" value={signerDraft.email} onInput={(e) => setSignerDraft({ ...signerDraft, email: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Phone</label>
                    <input type="tel" value={signerDraft.phone} onInput={(e) => setSignerDraft({ ...signerDraft, phone: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Role</label>
                    <select value={signerDraft.role} onChange={(e) => setSignerDraft({ ...signerDraft, role: (e.target as HTMLSelectElement).value as SignerRole })}>
                      {SIGNER_ROLES.map((r) => <option key={r} value={r}>{SIGNER_ROLE_LABELS[r]}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button class="btn btn-sm" onClick={() => setShowAddSigner(false)} disabled={savingSigner}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={submitAddSigner} disabled={savingSigner || !signerDraft.name.trim()}>{savingSigner ? "Adding..." : "Add Signer"}</button>
                </div>
              </div>
            )}
            {signers.length === 0 ? (
              <p class="text-muted">No signers added yet</p>
            ) : (
              <div class="card">
                <table class="table">
                  <thead><tr><th>Name</th><th>Email</th><th>Role</th>{isDraft && <th></th>}</tr></thead>
                  <tbody>
                    {signers.map((s) => (
                      <tr key={s.id} class="table-row">
                        <td>{s.name}</td>
                        <td class="text-muted">{s.email || "—"}</td>
                        <td class="text-muted">{SIGNER_ROLE_LABELS[s.role] || s.role}</td>
                        {isDraft && <td><button class="btn-icon danger" title="Remove" onClick={() => setPendingDeleteSigner(s.id)}><Trash2 size={12} /></button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isDraft && signers.length > 0 && (
              <button class="btn btn-sm btn-primary" style={{ marginTop: 8 }} onClick={() => setPendingSend(true)}>Send for Signature</button>
            )}
          </div>

          {freshLinks.length > 0 && (
            <div class="detail-section">
              <h3>Signing Links (share with each signer — shown once)</h3>
              <div class="card" style={{ padding: 12 }}>
                {freshLinks.map((l) => (
                  <div key={l.signer_id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span class="text-bold">{l.signer_name}:</span>
                    <input type="text" readOnly value={signingUrlFor(l.token)} style={{ flex: 1, fontSize: 12 }} onClick={(e) => (e.target as HTMLInputElement).select()} />
                    <button class="btn-icon" title="Select link" onClick={(e) => { const input = (e.currentTarget as HTMLElement).previousSibling as HTMLInputElement; input?.select(); }}><Copy size={14} /></button>
                  </div>
                ))}
                <p class="text-muted" style={{ fontSize: 12, marginTop: 6 }}>Email delivery is not yet automated — copy each link and send it to the signer manually.</p>
              </div>
            </div>
          )}

          {requests.length > 0 && (
            <div class="detail-section">
              <h3>Signature Requests</h3>
              <div class="card">
                <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Signer</th><th>Status</th><th>Expires</th><th></th></tr></thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} class="table-row">
                        <td>{signerById.get(r.signer_id)?.name ?? "—"}</td>
                        <td class="text-muted">{r.status}</td>
                        <td class="text-muted">{r.expires_at.slice(0, 10)}</td>
                        <td>
                          {["pending", "sent", "viewed", "expired"].includes(r.status) && (
                            <>
                              <button class="btn btn-sm" disabled={resendingRequestId === r.id} onClick={() => resendRequest(r.id)}>{resendingRequestId === r.id ? "..." : "Resend"}</button>
                              {" "}
                              {!["expired"].includes(r.status) && (
                                <button class="btn btn-sm" onClick={() => setPendingCancelRequest(r.id)}>Cancel</button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
              {resentToken && (
                <div class="card" style={{ padding: 12, marginTop: 8 }}>
                  <span class="text-bold">New link:</span>
                  <input type="text" readOnly value={signingUrlFor(resentToken.token)} style={{ marginLeft: 8, fontSize: 12, width: "60%" }} onClick={(e) => (e.target as HTMLInputElement).select()} />
                </div>
              )}
            </div>
          )}

          <div class="detail-section">
            <h3>Status History</h3>
            {history.length === 0 ? (
              <p class="text-muted">No history yet</p>
            ) : (
              <div class="card">
                <table class="table">
                  <thead><tr><th>From</th><th>To</th><th>When</th><th>Reason</th></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} class="table-row">
                        <td>{h.old_status ? (CONTRACT_STATUS_LABELS[h.old_status] || h.old_status) : "—"}</td>
                        <td>{CONTRACT_STATUS_LABELS[h.new_status] || h.new_status}</td>
                        <td class="text-muted">{new Date(h.created_at).toLocaleString()}</td>
                        <td class="text-muted">{h.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div class="detail-section">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3>Evidence</h3>
              {!showEvidence && <button class="btn btn-sm" onClick={loadEvidence}>View Evidence Package</button>}
            </div>
            {showEvidence && evidence && (
              <div class="card" style={{ padding: 12 }}>
                <p class="text-muted" style={{ fontSize: 12 }}>Document hash: <code>{evidence.document_hash || "not yet computed"}</code></p>
                <p class="text-muted" style={{ fontSize: 12 }}>Signed document hash: <code>{evidence.signed_document_hash || "not yet signed"}</code></p>
                {evidence.requests.map((r) => (
                  <div key={r.id} style={{ marginTop: 10 }}>
                    <p class="text-bold" style={{ fontSize: 13 }}>{r.signer?.name ?? "Unknown signer"} — {r.status}</p>
                    <ul style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0 0 16px" }}>
                      {r.events.map((e) => <li key={e.id}>{e.event_type} at {new Date(e.created_at).toLocaleString()}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Actions</h4>
            {allowed.length === 0 && !canCreateRevision ? (
              <p class="text-muted">No further actions available</p>
            ) : (
              <div class="status-buttons">
                {allowed.map((s) => (
                  <button key={s} class="status-btn" onClick={() => { setPendingTransition(s); setTransitionReason(""); }}>
                    {s === "voided" ? "Void Contract" : s === "cancelled" ? "Cancel Contract" : `Mark as ${CONTRACT_STATUS_LABELS[s] || s}`}
                  </button>
                ))}
                {canCreateRevision && (
                  <button class="status-btn" onClick={() => setPendingRevision(true)}>Create New Version</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingDeleteSigner !== null && (
        <ConfirmDialog
          title="Remove this signer?"
          message="This signer will be removed from the contract."
          confirmLabel="Remove" danger
          submitting={savingSigner}
          onConfirm={confirmDeleteSigner}
          onClose={() => setPendingDeleteSigner(null)}
        />
      )}

      {pendingSend && (
        <ConfirmDialog
          title="Send this contract for signature?"
          message="This locks the current version's terms, generates a unique signing link per signer, and marks the contract as Sent. Further edits will require creating a new version."
          confirmLabel="Send"
          submitting={sending}
          onConfirm={confirmSend}
          onClose={() => setPendingSend(false)}
        />
      )}

      {pendingTransition && (
        <div class="modal-overlay" onClick={() => !transitioning && setPendingTransition(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{pendingTransition === "voided" ? "Void this contract?" : "Cancel this contract?"}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setPendingTransition(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Reason {pendingTransition === "voided" ? "*" : "(optional)"}</label>
                <textarea rows={2} value={transitionReason} onInput={(e) => setTransitionReason((e.target as HTMLTextAreaElement).value)} />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingTransition(null)} disabled={transitioning}>Cancel</button>
              <button type="button" class="btn btn-danger" disabled={transitioning || (pendingTransition === "voided" && !transitionReason.trim())} onClick={confirmTransition}>
                {transitioning ? "Please wait..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRevision && (
        <ConfirmDialog
          title="Create a new version?"
          message="This creates a new draft version copied from the current one and moves the contract back to Draft for editing. Prior versions and any signatures already collected remain in history and cannot be changed."
          confirmLabel="Create New Version"
          submitting={creatingRevision}
          onConfirm={confirmRevision}
          onClose={() => setPendingRevision(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this draft contract?"
          message={`This permanently deletes draft contract ${contract.identifier}. This cannot be undone.`}
          confirmLabel="Delete" danger
          submitting={deleting}
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}

      {pendingCancelRequest !== null && (
        <ConfirmDialog
          title="Cancel this signature request?"
          message="The signer's link will stop working. You can send a new one later."
          confirmLabel="Cancel Request" danger
          submitting={cancellingRequest}
          onConfirm={confirmCancelRequest}
          onClose={() => setPendingCancelRequest(null)}
        />
      )}
    </div>
  );
}
