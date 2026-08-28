import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Plus } from "lucide-preact";
import type { LegalTermsDocument, LegalTermsVersion } from "../types";

/**
 * Phase 19B — Admin-only Legal Terms Library. Self-contained (own local
 * fetch/state). Draft content is editable in place; Publish is a one-way
 * action (Section 11 — published terms are immutable, superseded not
 * rewritten).
 */

const TERMS_TYPES = ["MAINTENANCE", "EQUIPMENT_SALE", "INSTALLATION", "QUOTE", "CONTRACT", "PAYMENT", "WARRANTY"];

export function LegalTerms() {
  const [documents, setDocuments] = useState<LegalTermsDocument[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [versions, setVersions] = useState<LegalTermsVersion[]>([]);
  const [draftContent, setDraftContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("MAINTENANCE");

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const data = await api<{ documents: LegalTermsDocument[] }>("GET", "/api/legal-terms");
      setDocuments(data.documents);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: number) => {
    const data = await api<{ document: LegalTermsDocument; versions: LegalTermsVersion[] }>("GET", `/api/legal-terms/${id}`);
    setVersions(data.versions);
    const draft = data.versions.find((v) => v.status === "draft");
    setDraftContent(draft?.content ?? "");
  };

  useEffect(() => { loadDocuments(); }, []);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId]);

  const createDocument = async () => {
    try {
      const res = await api<{ document: { id: number } }>("POST", "/api/legal-terms", { type: newType, title: newTitle.trim() });
      setShowCreate(false);
      setNewTitle("");
      await loadDocuments();
      setSelectedId(res.document.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const draftVersion = versions.find((v) => v.status === "draft");

  const saveDraft = async () => {
    if (!selectedId || !draftVersion) return;
    try {
      await api("PUT", `/api/legal-terms/${selectedId}/versions/${draftVersion.id}`, { content: draftContent });
      await loadDetail(selectedId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const publish = async () => {
    if (!selectedId || !draftVersion) return;
    if (!confirm(`Publish version ${draftVersion.version_number}? This is permanent — the previously published version will be superseded, never edited again.`)) return;
    try {
      await saveDraft();
      await api("POST", `/api/legal-terms/${selectedId}/versions/${draftVersion.id}/publish`, {});
      await loadDetail(selectedId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const newDraft = async () => {
    if (!selectedId) return;
    try {
      await api("POST", `/api/legal-terms/${selectedId}/versions`, {});
      await loadDetail(selectedId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Legal Terms Library</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New Document</button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 16 }}>
        <div class="card" style={{ flex: "0 0 280px" }}>
          {loading ? (
            <div class="loading-text">Loading...</div>
          ) : documents.length === 0 ? (
            <div class="empty-state"><p>No terms documents yet</p></div>
          ) : (
            <div class="table-wrap">
              {documents.map((d) => (
                <div
                  key={d.id} class={`sidebar-item ${selectedId === d.id ? "active" : ""}`}
                  role="button" tabIndex={0}
                  onClick={() => setSelectedId(d.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(d.id); }}
                >
                  <div>
                    <div class="text-bold">{d.title}</div>
                    <div class="text-muted" style={{ fontSize: 12 }}>{d.type}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="card" style={{ flex: 1 }}>
          {!selectedId ? (
            <div class="empty-state"><p>Select a document to view its versions</p></div>
          ) : (
            <>
              <h2>Versions</h2>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Version</th><th>Status</th><th>Effective From</th><th>Published</th></tr></thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id} class="table-row">
                        <td>{v.version_number}</td>
                        <td>{v.status}</td>
                        <td>{v.effective_from || "—"}</td>
                        <td>{v.published_at ? v.published_at.slice(0, 10) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {draftVersion ? (
                <div style={{ marginTop: 16 }}>
                  <div class="form-group">
                    <label for="lt-content">Draft Content (version {draftVersion.version_number})</label>
                    <textarea id="lt-content" rows={12} value={draftContent} onInput={(e) => setDraftContent((e.target as HTMLTextAreaElement).value)} />
                  </div>
                  <p class="text-muted" style={{ fontSize: 12 }}>
                    DRAFT / SAMPLE — REQUIRES BUSINESS/LEGAL REVIEW before publishing.
                  </p>
                  <button class="btn" onClick={saveDraft}>Save Draft</button>{" "}
                  <button class="btn btn-primary" onClick={publish}>Publish</button>
                </div>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <button class="btn" onClick={newDraft}>Create New Draft Version</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showCreate && (
        <div class="modal-overlay" onClick={() => setShowCreate(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header"><h2>New Terms Document</h2></div>
            <div class="modal-body">
              <div class="form-group">
                <label for="lt-type">Type</label>
                <select id="lt-type" value={newType} onChange={(e) => setNewType((e.target as HTMLSelectElement).value)}>
                  {TERMS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div class="form-group">
                <label for="lt-title">Title</label>
                <input id="lt-title" type="text" value={newTitle} onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)} placeholder="e.g. Residential Maintenance Terms" />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowCreate(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={!newTitle.trim()} onClick={createDocument}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
