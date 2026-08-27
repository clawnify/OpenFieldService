import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { useApp } from "../context";
import { api, apiUpload } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { scalePointerPosition } from "../signature-geometry";
import { CheckCircle2, Circle, AlertCircle, Camera, Trash2, PenLine } from "lucide-preact";
import type { Job, JobMedia, JobCompletionReport, JobSignature, CompletionCheck, MediaKind } from "../types";

const KIND_LABEL: Record<MediaKind, string> = {
  pre_work_photo: "Pre-work Photos",
  post_work_photo: "Post-work Photos",
};

/** Mobile-first technician completion checklist — the only place a technician
 *  interacts with Phase 4 compliance data. Every requirement here maps 1:1 to
 *  a canCompleteJob() requirement key on the server; this component never
 *  decides on its own whether the job can complete, it just reflects what the
 *  server says (via the `completion` prop, refreshed through `onChange`) and
 *  lets the technician satisfy each item with minimal taps. */
export function JobCompliance({
  job, completion, onChange,
}: {
  job: Job;
  completion: CompletionCheck | null;
  onChange: () => void;
}) {
  const { setError } = useApp();
  const [photos, setPhotos] = useState<JobMedia[]>([]);
  const [report, setReport] = useState<JobCompletionReport | null>(null);
  const [signatures, setSignatures] = useState<JobSignature[]>([]);
  const [loading, setLoading] = useState(true);

  const [reportDraft, setReportDraft] = useState({ work_performed: "", findings: "", notes: "", materials_used: "" });
  const [savingReport, setSavingReport] = useState(false);
  const [pendingSubmitReport, setPendingSubmitReport] = useState(false);
  const [submittingReport, setSubmittingReport] = useState(false);

  const [uploadingKind, setUploadingKind] = useState<MediaKind | null>(null);
  const [pendingDeletePhoto, setPendingDeletePhoto] = useState<JobMedia | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);

  const [showSignaturePad, setShowSignaturePad] = useState(false);

  const preFileInput = useRef<HTMLInputElement>(null);
  const postFileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [photosRes, reportRes, signaturesRes] = await Promise.all([
        api<{ photos: JobMedia[] }>("GET", `/api/jobs/${job.id}/photos`),
        api<JobCompletionReport | null>("GET", `/api/jobs/${job.id}/completion-report`),
        api<{ signatures: JobSignature[] }>("GET", `/api/jobs/${job.id}/signatures`),
      ]);
      setPhotos(photosRes.photos);
      setReport(reportRes);
      setSignatures(signaturesRes.signatures);
      if (reportRes) {
        setReportDraft({
          work_performed: reportRes.work_performed, findings: reportRes.findings,
          notes: reportRes.notes, materials_used: reportRes.materials_used,
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [job.id, setError]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = async (kind: MediaKind, file: File) => {
    setUploadingKind(kind);
    try {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", file);
      await apiUpload("POST", `/api/jobs/${job.id}/photos`, form);
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingKind(null);
    }
  };

  const handleConfirmDeletePhoto = async () => {
    if (!pendingDeletePhoto) return;
    setDeletingPhoto(true);
    try {
      await api("DELETE", `/api/jobs/${job.id}/photos/${pendingDeletePhoto.id}`);
      setPendingDeletePhoto(null);
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingPhoto(false);
    }
  };

  const handleSaveReport = async () => {
    setSavingReport(true);
    try {
      await api("PUT", `/api/jobs/${job.id}/completion-report`, reportDraft);
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingReport(false);
    }
  };

  const handleConfirmSubmitReport = async () => {
    setSubmittingReport(true);
    try {
      await api("POST", `/api/jobs/${job.id}/completion-report/submit`, {});
      setPendingSubmitReport(false);
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingReport(false);
    }
  };

  const requirement = (key: string) => completion?.requirements.find((r) => r.key === key);
  const photosFor = (kind: MediaKind) => photos.filter((p) => p.kind === kind);

  if (loading) return <div class="detail-sidebar-section"><p class="text-muted">Loading compliance checklist...</p></div>;

  return (
    <div class="detail-sidebar-section compliance-checklist">
      <h4>Completion Checklist</h4>

      {(["pre_work_photo", "post_work_photo"] as MediaKind[]).map((kind) => {
        const req = requirement(kind === "pre_work_photo" ? "pre_work_photos" : "post_work_photos");
        const kindPhotos = photosFor(kind);
        const inputRef = kind === "pre_work_photo" ? preFileInput : postFileInput;
        return (
          <div class="compliance-item" key={kind}>
            <div class="compliance-item-header">
              {req?.satisfied ? <CheckCircle2 size={18} color="#16a34a" /> : <Circle size={18} color="#dc2626" />}
              <span>{KIND_LABEL[kind]}</span>
              <span class="text-muted">{kindPhotos.length} photo{kindPhotos.length === 1 ? "" : "s"}</span>
            </div>
            {kindPhotos.length > 0 && (
              <div class="compliance-photo-grid">
                {kindPhotos.map((p) => (
                  <div class="compliance-photo-thumb" key={p.id}>
                    <img src={`/api/jobs/${job.id}/photos/${p.id}/file`} alt={KIND_LABEL[kind]} />
                    <button class="btn-icon danger" title="Delete photo" aria-label={`Delete ${KIND_LABEL[kind]} photo`} onClick={() => setPendingDeletePhoto(p)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={inputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              aria-label={`Add ${KIND_LABEL[kind]}`}
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) handleUpload(kind, file);
                (e.target as HTMLInputElement).value = "";
              }}
            />
            <button class="btn btn-sm" disabled={uploadingKind === kind} onClick={() => inputRef.current?.click()}>
              <Camera size={14} /> {uploadingKind === kind ? "Uploading..." : "Add Photo"}
            </button>
          </div>
        );
      })}

      <div class="compliance-item">
        <div class="compliance-item-header">
          {requirement("technician_report")?.satisfied ? <CheckCircle2 size={18} color="#16a34a" /> : <Circle size={18} color="#dc2626" />}
          <span>Technician Report</span>
          <span class="text-muted">{report?.status === "submitted" ? "Submitted" : "Draft"}</span>
        </div>
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="jc-work-performed">Work Performed</label>
            <textarea
              id="jc-work-performed"
              rows={2} value={reportDraft.work_performed}
              onInput={(e) => setReportDraft({ ...reportDraft, work_performed: (e.target as HTMLTextAreaElement).value })}
              placeholder="What did you do on this job?"
            />
          </div>
          <div class="form-group full-width">
            <label for="jc-findings">Findings</label>
            <textarea
              id="jc-findings"
              rows={2} value={reportDraft.findings}
              onInput={(e) => setReportDraft({ ...reportDraft, findings: (e.target as HTMLTextAreaElement).value })}
            />
          </div>
          <div class="form-group full-width">
            <label for="jc-materials-used">Materials Used</label>
            <input
              id="jc-materials-used"
              type="text" value={reportDraft.materials_used}
              onInput={(e) => setReportDraft({ ...reportDraft, materials_used: (e.target as HTMLInputElement).value })}
            />
          </div>
          <div class="form-group full-width">
            <label for="jc-notes">Notes</label>
            <textarea
              id="jc-notes"
              rows={2} value={reportDraft.notes}
              onInput={(e) => setReportDraft({ ...reportDraft, notes: (e.target as HTMLTextAreaElement).value })}
            />
          </div>
        </div>
        <div class="action-btns">
          <button class="btn btn-sm" disabled={savingReport} onClick={handleSaveReport}>
            {savingReport ? "Saving..." : "Save Draft"}
          </button>
          <button class="btn btn-sm btn-primary" onClick={() => setPendingSubmitReport(true)}>
            Submit Report
          </button>
        </div>
        {report?.status === "submitted" && (
          <p class="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
            Editing will revert this report to draft until resubmitted.
          </p>
        )}
      </div>

      <div class="compliance-item">
        <div class="compliance-item-header">
          {requirement("customer_signature")?.satisfied ? <CheckCircle2 size={18} color="#16a34a" /> : <Circle size={18} color="#dc2626" />}
          <span>Customer Signature</span>
          <span class="text-muted">{signatures.length > 0 ? `Signed by ${signatures[0].signer_name}` : "Required"}</span>
        </div>
        <button class="btn btn-sm" onClick={() => setShowSignaturePad(true)}>
          <PenLine size={14} /> {signatures.length > 0 ? "Capture New Signature" : "Capture Signature"}
        </button>
      </div>

      {completion && !completion.allowed && (
        <div class="inline-notice compliance-summary">
          <AlertCircle size={14} style={{ verticalAlign: "text-bottom" }} /> Complete Job is disabled until every item above is checked off.
        </div>
      )}

      {pendingDeletePhoto && (
        <ConfirmDialog
          title="Delete this photo?"
          message="This photo will be removed from the completion checklist. This cannot be undone from here."
          confirmLabel="Delete"
          danger
          submitting={deletingPhoto}
          onConfirm={handleConfirmDeletePhoto}
          onClose={() => setPendingDeletePhoto(null)}
        />
      )}

      {pendingSubmitReport && (
        <ConfirmDialog
          title="Submit technician report?"
          message="Once submitted, this report counts toward job completion. You can still edit it later, but editing will require resubmitting."
          confirmLabel="Submit Report"
          submitting={submittingReport}
          onConfirm={handleConfirmSubmitReport}
          onClose={() => setPendingSubmitReport(false)}
        />
      )}

      {showSignaturePad && (
        <SignaturePad
          jobId={job.id}
          onCaptured={async () => {
            setShowSignaturePad(false);
            await refresh();
            onChange();
          }}
          onClose={() => setShowSignaturePad(false)}
        />
      )}
    </div>
  );
}

function SignaturePad({ jobId, onCaptured, onClose }: { jobId: number; onCaptured: () => void; onClose: () => void }) {
  const { setError } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  const [signerName, setSignerName] = useState("");
  const [signerRelationship, setSignerRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);

  const getPos = (e: PointerEvent, canvas: HTMLCanvasElement) =>
    scalePointerPosition(e.clientX, e.clientY, canvas.getBoundingClientRect(), canvas);

  const start = (e: PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    hasDrawn.current = true;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: PointerEvent) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const end = () => { drawing.current = false; };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn.current = false;
  };

  const requestSave = () => {
    if (!signerName.trim()) { setError("Enter the customer's name"); return; }
    if (!hasDrawn.current) { setError("Please sign in the box before saving"); return; }
    setPendingSave(true);
  };

  const confirmSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      await api("POST", `/api/jobs/${jobId}/signature`, {
        signer_name: signerName.trim(),
        signer_relationship: signerRelationship.trim(),
        signature_data_url: canvas.toDataURL("image/png"),
      });
      setPendingSave(false);
      onCaptured();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Customer Signature</h2>
        </div>
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="sig-signer-name">Customer Name *</label>
            <input id="sig-signer-name" type="text" value={signerName} onInput={(e) => setSignerName((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-group full-width">
            <label for="sig-signer-relationship">Relationship (optional)</label>
            <input id="sig-signer-relationship" type="text" value={signerRelationship} onInput={(e) => setSignerRelationship((e.target as HTMLInputElement).value)} placeholder="Owner, Property Manager, ..." />
          </div>
        </div>
        <p class="text-muted signature-instruction">Have the customer sign in the box below with a finger or stylus.</p>
        <canvas
          ref={canvasRef} width={400} height={160} class="signature-canvas"
          aria-label="Signature drawing area"
          onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerLeave={end}
        />
        <div class="modal-footer">
          <button type="button" class="btn" onClick={clear} aria-label="Clear signature">Clear</button>
          <button type="button" class="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" class="btn btn-primary" onClick={requestSave} disabled={saving}>
            {saving ? "Saving..." : "Save Signature"}
          </button>
        </div>
      </div>
    </div>

    {pendingSave && (
      <ConfirmDialog
        title="Save this signature?"
        message={`Record this signature for ${signerName.trim()}${signerRelationship.trim() ? ` (${signerRelationship.trim()})` : ""} as part of this job's completion documentation?`}
        confirmLabel="Save Signature"
        submitting={saving}
        onConfirm={confirmSave}
        onClose={() => setPendingSave(false)}
      />
    )}
    </>
  );
}
