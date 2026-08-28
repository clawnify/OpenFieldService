import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { AgreementStatusBadge } from "./maintenance-agreement-list";
import { ArrowLeft, Copy } from "lucide-preact";
import type {
  MaintenanceAgreement, MaintenanceAgreementVersion, CoveredEquipment, AgreementSigner,
  AgreementSignatureRequest, MaintenanceMembership, Asset,
} from "../types";

interface DetailResponse {
  agreement: MaintenanceAgreement;
  version: MaintenanceAgreementVersion | null;
  coveredEquipment: CoveredEquipment[];
  signers: AgreementSigner[];
  signatureRequests: AgreementSignatureRequest[];
}

/**
 * Phase 19B — Maintenance Agreement detail. Self-contained (own local
 * fetch/state), same precedent as contract-detail.tsx/quote-detail.tsx.
 */
export function MaintenanceAgreementDetail({ id, navigate }: { id: number; navigate: (to: string) => void }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [membership, setMembership] = useState<MaintenanceMembership | null>(null);
  const [entitlement, setEntitlement] = useState<{ visitsIncluded: number | null; visitsConsumed: number; visitsRemaining: number | null } | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [signingLinks, setSigningLinks] = useState<{ signerId: number; signerName: string; token: string }[]>([]);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<number | "">("");
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = async () => {
    try {
      const data = await api<DetailResponse>("GET", `/api/maintenance/agreements/${id}`);
      setDetail(data);
      if (data.agreement.status === "draft") {
        const a = await api<{ assets: Asset[] }>("GET", `/api/assets?customer_id=${data.agreement.customer_id}`);
        setAssets(a.assets);
      }
      const m = await api<{ membership: MaintenanceMembership | null }>("GET", `/api/maintenance/agreements/${id}/membership`);
      setMembership(m.membership);
      if (m.membership) {
        const e = await api<{ visitsIncluded: number | null; visitsConsumed: number; visitsRemaining: number | null }>("GET", `/api/maintenance/memberships/${m.membership.id}`);
        setEntitlement(e);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) return <div class="loading-text">Loading...</div>;
  const { agreement, version, coveredEquipment, signers, signatureRequests } = detail;
  const planSnapshot = version ? JSON.parse(version.plan_snapshot || "{}") : {};
  const isDraft = agreement.status === "draft";

  const addSigner = async () => {
    if (!signerName.trim()) return;
    try {
      await api("POST", `/api/maintenance/agreements/${id}/signers`, { name: signerName.trim(), email: signerEmail.trim() });
      setSignerName("");
      setSignerEmail("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const attachAsset = async () => {
    if (!selectedAssetId) return;
    try {
      await api("POST", `/api/maintenance/agreements/${id}/covered-equipment`, { asset_ids: [selectedAssetId] });
      setSelectedAssetId("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeEquipment = async (equipmentId: number) => {
    try {
      await api("DELETE", `/api/maintenance/agreements/${id}/covered-equipment/${equipmentId}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const sendForSignature = async () => {
    try {
      const res = await api<{ signingLinks: { signerId: number; signerName: string; token: string }[] }>(
        "POST", `/api/maintenance/agreements/${id}/send`, { consent_text_version: "esign-consent-v1" }
      );
      setSigningLinks(res.signingLinks);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancelAgreement = async () => {
    if (!cancelReason.trim()) return;
    try {
      await api("POST", `/api/maintenance/agreements/${id}/transition`, { to_status: "cancelled", reason: cancelReason.trim() });
      setShowCancel(false);
      setCancelReason("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/sign-maintenance/${token}`;
    navigator.clipboard?.writeText(url).catch(() => {});
  };

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn-icon" aria-label="Back to Maintenance Agreements" onClick={() => navigate("/maintenance-agreements")}><ArrowLeft size={18} /></button>
        <h1>{agreement.identifier}</h1>
        <AgreementStatusBadge status={agreement.status} />
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        <h2>Plan</h2>
        <p class="text-bold">{planSnapshot.name} ({planSnapshot.tier})</p>
        <p class="text-muted">{planSnapshot.description}</p>
        <p>Price: {formatCents(version?.total_price_cents ?? 0)}</p>
        <p>Included Visits: {planSnapshot.visit_entitlement_count == null ? "Unlimited" : planSnapshot.visit_entitlement_count}</p>
        {planSnapshot.priority_benefit && <p>Priority Benefit: {planSnapshot.priority_benefit}</p>}
      </div>

      {membership && entitlement && (
        <div class="card">
          <h2>Membership</h2>
          <p>Status: {membership.status}</p>
          <p>Visits: {entitlement.visitsConsumed} used{entitlement.visitsRemaining !== null ? ` / ${entitlement.visitsRemaining} remaining` : ""}</p>
        </div>
      )}

      <div class="card">
        <h2>Covered Equipment</h2>
        {coveredEquipment.length === 0 ? (
          <p class="text-muted">No specific equipment listed.</p>
        ) : (
          <ul>
            {coveredEquipment.map((ce) => {
              const snap = JSON.parse(ce.asset_snapshot || "{}");
              return (
                <li key={ce.id}>
                  {snap.display_name || snap.asset_type} — {snap.manufacturer} {snap.model} (SN: {snap.serial_number || "—"})
                  {isDraft && <button class="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => removeEquipment(ce.id)}>Remove</button>}
                </li>
              );
            })}
          </ul>
        )}
        {isDraft && assets.length > 0 && (
          <div class="form-row" style={{ marginTop: 8 }}>
            <select aria-label="Select equipment to attach" value={selectedAssetId} onChange={(e) => setSelectedAssetId(Number((e.target as HTMLSelectElement).value))}>
              <option value="">Select equipment...</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.asset_type} — {a.manufacturer} {a.model}</option>)}
            </select>
            <button class="btn btn-sm" onClick={attachAsset}>Attach</button>
          </div>
        )}
      </div>

      <div class="card">
        <h2>Signers</h2>
        {signers.length === 0 ? (
          <p class="text-muted">No signers added yet.</p>
        ) : (
          <ul>
            {signers.map((s) => {
              const req = signatureRequests.find((r) => r.signer_id === s.id);
              return <li key={s.id}>{s.name} ({s.email}) — {req?.status ?? "not sent"}</li>;
            })}
          </ul>
        )}
        {isDraft && (
          <div class="form-row" style={{ marginTop: 8 }}>
            <input type="text" aria-label="Signer name" placeholder="Signer name" value={signerName} onInput={(e) => setSignerName((e.target as HTMLInputElement).value)} />
            <input type="text" aria-label="Signer email" placeholder="Signer email" value={signerEmail} onInput={(e) => setSignerEmail((e.target as HTMLInputElement).value)} />
            <button class="btn btn-sm" onClick={addSigner}>Add Signer</button>
          </div>
        )}
        {isDraft && signers.length > 0 && (
          <button class="btn btn-primary" style={{ marginTop: 8 }} onClick={sendForSignature}>Send for Signature</button>
        )}
        {signingLinks.length > 0 && (
          <div class="card" style={{ marginTop: 8 }}>
            <p class="text-bold">Signing links (share with each signer):</p>
            {signingLinks.map((l) => (
              <div key={l.signerId} class="form-row">
                <code style={{ fontSize: 12 }}>{window.location.origin}/sign-maintenance/{l.token}</code>
                <button class="btn-icon" aria-label={`Copy signing link for ${l.signerName}`} onClick={() => copyLink(l.token)}><Copy size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {version?.signed_at && (
        <div class="card">
          <h2>Signed Agreement</h2>
          <p class="text-muted">Signed {version.signed_at.slice(0, 10)}</p>
          <a class="btn btn-sm" href={`/api/maintenance/agreements/${id}/signed-document`} target="_blank" rel="noopener noreferrer">View PDF</a>{" "}
          <a class="btn btn-sm" href={`/api/maintenance/agreements/${id}/signed-document?mode=download`}>Download</a>
        </div>
      )}

      {["draft", "sent", "viewed", "signed", "active"].includes(agreement.status) && (
        <div class="card">
          <h2>Cancel Agreement</h2>
          {!showCancel ? (
            <button class="btn btn-danger" onClick={() => setShowCancel(true)}>Cancel Agreement</button>
          ) : (
            <div>
              <div class="form-group">
                <label for="ma-cancel-reason">Reason</label>
                <textarea id="ma-cancel-reason" rows={2} value={cancelReason} onInput={(e) => setCancelReason((e.target as HTMLTextAreaElement).value)} />
              </div>
              <button class="btn" onClick={() => setShowCancel(false)}>Back</button>{" "}
              <button class="btn btn-danger" disabled={!cancelReason.trim()} onClick={cancelAgreement}>Confirm Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
