import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useReferenceData } from "../reference-data";
import { Plus, X, Wrench } from "lucide-preact";
import type { Asset } from "../types";

/**
 * Phase 11.4 — Linked Equipment on a Job. Self-contained (own fetch/state),
 * same precedent as JobCompliance/NotificationHistory rather than folding
 * into JobDetail's own large state block.
 *
 * Visible to every role (including technician — GET /api/jobs/{id}/assets
 * reuses the same own-assigned-job ownership check as the rest of Job
 * read access). Link/unlink controls are hidden for `role === "technician"`
 * client-side only — the server independently blocks the mutation routes
 * for that role regardless of what this component renders.
 */
export function JobAssets({ jobId, customerId, role }: { jobId: number; customerId: number; role: string | undefined }) {
  const { assetTypes } = useReferenceData();
  const [linked, setLinked] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [candidates, setCandidates] = useState<Asset[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<number | null>(null);

  const isFieldTechnician = role === "technician";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<{ assets: Asset[] }>("GET", `/api/jobs/${jobId}/assets`);
      setLinked(res.assets);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const typeLabel = (key: string) => assetTypes.find((t) => t.key === key)?.label || key || "—";

  const openLinkPicker = async () => {
    setMutationError(null);
    setSelectedAssetId("");
    setShowLinkPicker(true);
    setLoadingCandidates(true);
    try {
      const res = await api<{ assets: Asset[] }>("GET", `/api/assets?customer_id=${customerId}&status=active`);
      setCandidates(res.assets.filter((a) => !linked.some((l) => l.id === a.id)));
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setLoadingCandidates(false);
    }
  };

  const confirmLink = async () => {
    if (!selectedAssetId) return;
    setLinking(true);
    setMutationError(null);
    try {
      await api("POST", `/api/jobs/${jobId}/assets`, { asset_id: parseInt(selectedAssetId, 10) });
      setShowLinkPicker(false);
      await load();
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async (assetId: number) => {
    setUnlinkingId(assetId);
    setMutationError(null);
    try {
      await api("DELETE", `/api/jobs/${jobId}/assets/${assetId}`);
      await load();
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setUnlinkingId(null);
    }
  };

  return (
    <div class="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3><Wrench size={16} style={{ verticalAlign: "text-bottom" }} /> Linked Equipment</h3>
        {!isFieldTechnician && !showLinkPicker && (
          <button class="btn btn-sm" onClick={openLinkPicker}><Plus size={14} /> Link Equipment</button>
        )}
      </div>

      {mutationError && <div class="inline-error" style={{ marginTop: 4, marginBottom: 8 }}>{mutationError}</div>}

      {showLinkPicker && (
        <div class="card" style={{ padding: 12, marginBottom: 12 }}>
          {loadingCandidates ? (
            <p class="text-muted">Loading this customer's equipment...</p>
          ) : candidates.length === 0 ? (
            <p class="text-muted">No unlinked active equipment on file for this customer.</p>
          ) : (
            <div class="note-input-row">
              <select value={selectedAssetId} onChange={(e) => setSelectedAssetId((e.target as HTMLSelectElement).value)} style={{ flex: 1 }}>
                <option value="">Select equipment...</option>
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {typeLabel(a.asset_type)}{a.display_name ? ` — ${a.display_name}` : ""}{a.model ? ` (${a.model})` : ""}
                  </option>
                ))}
              </select>
              <button class="btn btn-primary btn-sm" disabled={!selectedAssetId || linking} onClick={confirmLink}>
                {linking ? "Linking..." : "Link"}
              </button>
            </div>
          )}
          <button class="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowLinkPicker(false)}>Cancel</button>
        </div>
      )}

      {loading ? (
        <p class="text-muted">Loading...</p>
      ) : loadError ? (
        <div class="inline-error">{loadError}</div>
      ) : linked.length === 0 ? (
        <p class="text-muted">No equipment linked to this job</p>
      ) : (
        <div class="card">
          <table class="table">
            <thead>
              <tr><th>Type</th><th>Name</th><th>Manufacturer / Model</th><th>Serial</th>{!isFieldTechnician && <th></th>}</tr>
            </thead>
            <tbody>
              {linked.map((a) => (
                <tr key={a.id} class="table-row">
                  <td>{typeLabel(a.asset_type)}</td>
                  <td>{a.display_name || "—"}</td>
                  <td>{[a.manufacturer, a.model].filter(Boolean).join(" / ") || "—"}</td>
                  <td>{a.serial_number || "—"}</td>
                  {!isFieldTechnician && (
                    <td>
                      <button
                        class="btn-icon danger"
                        aria-label={`Unlink ${a.display_name || typeLabel(a.asset_type)}`}
                        disabled={unlinkingId === a.id}
                        onClick={() => handleUnlink(a.id)}
                      >
                        <X size={14} />
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
