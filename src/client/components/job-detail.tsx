import { useState, useEffect } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { StatusBadge, PriorityBadge, STATUS_LABELS } from "./status-badge";
import { JOB_TYPE_LABELS } from "../job-type-labels";
import { ConfirmDialog } from "./confirm-dialog";
import { GoogleSyncBadge } from "./google-sync-badge";
import { JobCompliance } from "./job-compliance";
import { JobMaintenanceReport } from "./job-maintenance-report";
import { ScheduleEditModal } from "./schedule-edit-modal";
import { NotificationHistory } from "./notification-history";
import { JobAssets } from "./job-assets";
import { buildNavigationUrl, buildTelUrl, buildSmsUrl } from "../navigation";
import {
  ArrowLeft, Trash2, Send, MapPin, Clock, DollarSign, User, Wrench, Plus, X, CheckSquare, Square, Package, FileText, BadgeCheck,
  Phone, MessageSquare, Navigation2, CalendarClock,
} from "lucide-preact";
import type { CompletionCheck, RebateEligibilityResult, RebateAuditRow } from "../types";

export function JobDetail() {
  const {
    selectedJob: job, navigate, updateJob, transitionJob, deleteJob, setError,
    addJobNote, deleteJobNote, technicianLookup, isAgent,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
    addJobMaterial, deleteJobMaterial, materials, createInvoiceFromJob,
  } = useApp();
  const { user } = useAuth();
  const canManageRebate = user?.role === "admin" || user?.role === "dispatcher";
  const canManageFinancials = user?.role === "admin" || user?.role === "dispatcher";
  // Delete and reassignment are always rejected server-side for a technician
  // actor (see mem:project/fsm-upgrade-plan's destructive-mutation RBAC fix
  // and the Phase 2 schedule-edit gate) — hiding them here is a UX
  // improvement only (avoids a guaranteed-403 dead end), not a new
  // authorization mechanism; the server remains the sole enforcement point.
  const isFieldTechnician = user?.role === "technician";
  const [noteText, setNoteText] = useState("");
  const [pendingCreateInvoice, setPendingCreateInvoice] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [checklistText, setChecklistText] = useState("");
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [materialId, setMaterialId] = useState("");
  const [materialQty, setMaterialQty] = useState("1");

  const [allowedTransitions, setAllowedTransitions] = useState<string[]>([]);
  const [completion, setCompletion] = useState<CompletionCheck | null>(null);
  const [pendingTransition, setPendingTransition] = useState<string | null>(null);
  const [eligCode, setEligCode] = useState("");
  const [eligExpiry, setEligExpiry] = useState("");
  const [transitioning, setTransitioning] = useState(false);

  const [pendingTechnician, setPendingTechnician] = useState<{ id: number | null; name: string } | null>(null);
  const [reassigning, setReassigning] = useState(false);

  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [showScheduleEdit, setShowScheduleEdit] = useState(false);

  const [checking, setChecking] = useState(false);
  const [pendingCheck, setPendingCheck] = useState(false);
  const [checkResult, setCheckResult] = useState<RebateEligibilityResult | null>(null);
  const [rebateAudit, setRebateAudit] = useState<RebateAuditRow[]>([]);

  const [editingEligibility, setEditingEligibility] = useState(false);
  const [editCode, setEditCode] = useState("");
  const [editExpiry, setEditExpiry] = useState("");
  const [pendingEligibilityEdit, setPendingEligibilityEdit] = useState(false);
  const [savingEligibility, setSavingEligibility] = useState(false);

  const jobId = job?.id;
  const jobStatus = job?.status;
  const jobType = job?.job_type;

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ allowed: string[] }>("GET", `/api/jobs/${jobId}/transitions`);
        if (!cancelled) setAllowedTransitions(res.allowed);
      } catch {
        if (!cancelled) setAllowedTransitions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, jobStatus]);

  useEffect(() => {
    if (!jobId || !allowedTransitions.includes("completed")) { setCompletion(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api<CompletionCheck>("GET", `/api/jobs/${jobId}/can-complete`);
        if (!cancelled) setCompletion(res);
      } catch {
        if (!cancelled) setCompletion(null);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, jobStatus, allowedTransitions]);

  const refreshCompletion = async () => {
    if (!jobId || !allowedTransitions.includes("completed")) return;
    try {
      const res = await api<CompletionCheck>("GET", `/api/jobs/${jobId}/can-complete`);
      setCompletion(res);
    } catch {
      // leave prior completion state as-is; the checklist UI will surface the error via setError
    }
  };

  useEffect(() => {
    if (!jobId || jobType === "STANDARD") { setRebateAudit([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ audit: RebateAuditRow[] }>("GET", `/api/jobs/${jobId}/rebate-audit`);
        if (!cancelled) setRebateAudit(res.audit);
      } catch {
        if (!cancelled) setRebateAudit([]);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, jobType, jobStatus]);

  if (!job) return null;

  const handleConfirmTransition = async () => {
    if (!pendingTransition) return;
    setTransitioning(true);
    try {
      await transitionJob(
        job.id, pendingTransition,
        pendingTransition === "eligibility_approved"
          ? { eligibility_code: eligCode, eligibility_code_expiry: eligExpiry }
          : undefined
      );
      setPendingTransition(null);
      setEligCode("");
      setEligExpiry("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTransitioning(false);
    }
  };

  const handleConfirmReassign = async () => {
    if (!pendingTechnician) return;
    setReassigning(true);
    try {
      await updateJob(job.id, { technician_id: pendingTechnician.id });
      setPendingTechnician(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReassigning(false);
    }
  };

  const handleConfirmCreateInvoice = async () => {
    setCreatingInvoice(true);
    try {
      await createInvoiceFromJob(job.id);
      setPendingCreateInvoice(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteJob(job.id);
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  const transitionBlocked = pendingTransition === "eligibility_approved"
    ? !eligCode.trim() || !eligExpiry.trim()
    : pendingTransition === "completed" && completion !== null && !completion.allowed;

  const handleConfirmCheck = async () => {
    setChecking(true);
    try {
      const res = await api<RebateEligibilityResult>("POST", `/api/jobs/${job.id}/eligibility-check`, {});
      setCheckResult(res);
      const audit = await api<{ audit: RebateAuditRow[] }>("GET", `/api/jobs/${job.id}/rebate-audit`);
      setRebateAudit(audit.audit);
      setPendingCheck(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const startEditEligibility = () => {
    setEditCode(job.eligibility_code);
    setEditExpiry(job.eligibility_code_expiry);
    setEditingEligibility(true);
  };

  const handleConfirmEligibilityEdit = async () => {
    setSavingEligibility(true);
    try {
      await api("PUT", `/api/jobs/${job.id}/eligibility`, { eligibility_code: editCode, eligibility_code_expiry: editExpiry });
      const auditRes = await api<{ audit: RebateAuditRow[] }>("GET", `/api/jobs/${job.id}/rebate-audit`);
      setRebateAudit(auditRes.audit);
      setEditingEligibility(false);
      setPendingEligibilityEdit(false);
      // Empty PUT just to reuse updateJob()'s existing "refetch selectedJob" side effect,
      // since eligibility_code/expiry live on the job row but were changed via a different route.
      await updateJob(job.id, {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingEligibility(false);
    }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    await addJobNote(job.id, noteText.trim());
    setNoteText("");
  };

  const handleAddChecklist = async () => {
    if (!checklistText.trim()) return;
    await addChecklistItem(job.id, checklistText.trim());
    setChecklistText("");
  };

  const handleAddMaterial = async () => {
    if (!materialId) return;
    await addJobMaterial(job.id, parseInt(materialId, 10), parseFloat(materialQty) || 1);
    setMaterialId("");
    setMaterialQty("1");
    setShowAddMaterial(false);
  };

  const telUrl = job.customer_phone ? buildTelUrl(job.customer_phone) : null;
  const smsUrl = job.customer_phone ? buildSmsUrl(job.customer_phone) : null;
  const navUrl = job.address ? buildNavigationUrl(job.address) : null;

  // Mobile sticky action bar (CSS-gated to phone widths, see styles.css):
  // mirrors, rather than duplicates, the status-transition buttons already
  // rendered in the sidebar below — same allowedTransitions data from
  // GET /api/jobs/{id}/transitions, same setPendingTransition handler, same
  // completion-gate text. "completed" is preferred as the primary CTA
  // whenever it's an option since finishing the job is always the most
  // actionable next step; the server remains the sole authority on whether
  // any of this is actually allowed.
  const primaryTransition = allowedTransitions.includes("completed") ? "completed" : allowedTransitions[0];
  const incompleteCount = completion?.requirements.filter((r) => !r.satisfied).length ?? 0;

  return (
    <div class="page job-detail-page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/jobs")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          {canManageFinancials && (
            <button class="btn" onClick={() => setPendingCreateInvoice(true)}>
              <FileText size={14} /> Create Invoice
            </button>
          )}
          {!isFieldTechnician && (
            <button class="btn btn-danger" onClick={() => setPendingDelete(true)}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{job.identifier}</span>
            <StatusBadge status={job.status} />
            <PriorityBadge priority={job.priority} />
            <span class="text-muted">{JOB_TYPE_LABELS[job.job_type]}</span>
          </div>

          <div class="detail-meta-grid">
            <div class="detail-meta-item">
              <User size={14} />
              <span class="detail-meta-label">Customer</span>
              <span>{job.customer_name || "—"}</span>
              {job.customer_phone && <span class="text-muted">{job.customer_phone}</span>}
              {job.customer_phone && (telUrl || smsUrl) && (
                <div class="contact-actions">
                  {telUrl && (
                    <a class="btn btn-sm" href={telUrl} aria-label={`Call ${job.customer_name || "customer"}`}>
                      <Phone size={14} /> Call
                    </a>
                  )}
                  {smsUrl && (
                    <a class="btn btn-sm" href={smsUrl} aria-label={`Text ${job.customer_name || "customer"}`}>
                      <MessageSquare size={14} /> Text
                    </a>
                  )}
                </div>
              )}
            </div>
            <div class="detail-meta-item">
              <MapPin size={14} />
              <span class="detail-meta-label">Address</span>
              <span>{job.address || "—"}</span>
              {navUrl && (
                <div class="contact-actions">
                  <a class="btn btn-sm" href={navUrl} target="_blank" rel="noopener noreferrer" aria-label={`Navigate to ${job.address}`}>
                    <Navigation2 size={14} /> Navigate
                  </a>
                </div>
              )}
            </div>
            <div class="detail-meta-item">
              <Clock size={14} />
              <span class="detail-meta-label">Scheduled</span>
              <span>{job.scheduled_date} at {job.scheduled_time}</span>
              <span class="text-muted">{job.duration} min</span>
              {!isFieldTechnician && (
                <div class="contact-actions">
                  <button type="button" class="btn btn-sm" onClick={() => setShowScheduleEdit(true)}>
                    <CalendarClock size={14} /> Change Schedule
                  </button>
                </div>
              )}
            </div>
            <div class="detail-meta-item">
              <DollarSign size={14} />
              <span class="detail-meta-label">Price</span>
              <span>${job.price.toFixed(2)}</span>
            </div>
            {job.service_type_name && (
              <div class="detail-meta-item">
                <Wrench size={14} />
                <span class="detail-meta-label">Service</span>
                <span class="service-pill" style={{ borderColor: job.service_type_color || "#ccc" }}>
                  <span class="service-dot" style={{ background: job.service_type_color || "#ccc" }} />
                  {job.service_type_name}
                </span>
              </div>
            )}
            <div class="detail-meta-item">
              <User size={14} />
              <span class="detail-meta-label">Technician</span>
              {job.technician_name ? (
                <span class="tech-pill" style={{ borderColor: job.technician_color || "#ccc" }}>
                  <span class="tech-dot" style={{ background: job.technician_color || "#ccc" }} />
                  {job.technician_name}
                </span>
              ) : (
                <span class="text-muted">Unassigned</span>
              )}
            </div>
          </div>

          {job.notes && (
            <div class="detail-section">
              <h3>Notes</h3>
              <p class="detail-notes">{job.notes}</p>
            </div>
          )}

          {/* Checklist */}
          <div class="detail-section">
            <h3><CheckSquare size={16} style={{ verticalAlign: "text-bottom" }} /> Checklist</h3>
            <div class="checklist-list">
              {(job.checklist || []).map((item) => (
                <div key={item.id} class="checklist-item">
                  <button class="checklist-toggle" onClick={() => toggleChecklistItem(item.id)}>
                    {item.checked ? <CheckSquare size={16} color="#16a34a" /> : <Square size={16} />}
                  </button>
                  <span class={item.checked ? "checklist-done" : ""}>{item.label}</span>
                  {isAgent && (
                    <button class="btn-icon danger" onClick={() => deleteChecklistItem(item.id)}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div class="note-input-row">
              <input
                type="text"
                value={checklistText}
                onInput={(e) => setChecklistText((e.target as HTMLInputElement).value)}
                placeholder="Add checklist item..."
                aria-label="Add checklist item"
                onKeyDown={(e) => e.key === "Enter" && handleAddChecklist()}
              />
              <button class="btn btn-primary btn-sm" onClick={handleAddChecklist}>
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Materials Used */}
          <div class="detail-section">
            <h3><Package size={16} style={{ verticalAlign: "text-bottom" }} /> Materials Used</h3>
            {(job.job_materials || []).length > 0 && (
              <div class="card" style={{ marginBottom: 12 }}>
                <table class="table">
                  <thead>
                    <tr><th>Material</th><th>Qty</th><th>Unit Cost</th><th>Total</th>{isAgent && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {(job.job_materials || []).map((jm) => (
                      <tr key={jm.id} class="table-row">
                        <td>{jm.material_name || "—"}</td>
                        <td>{jm.quantity} {jm.material_unit}</td>
                        <td>${jm.unit_cost.toFixed(2)}</td>
                        <td class="text-bold">${(jm.quantity * jm.unit_cost).toFixed(2)}</td>
                        {isAgent && (
                          <td><button class="btn-icon danger" onClick={() => deleteJobMaterial(jm.id)}><Trash2 size={12} /></button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {showAddMaterial ? (
              <div class="note-input-row">
                <select value={materialId} onChange={(e) => setMaterialId((e.target as HTMLSelectElement).value)} style={{ flex: 2 }} aria-label="Select material">
                  <option value="">Select material...</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} (${m.unit_cost}/{m.unit})</option>
                  ))}
                </select>
                <input type="number" value={materialQty} onInput={(e) => setMaterialQty((e.target as HTMLInputElement).value)} style={{ width: 70 }} min="0.1" step="0.1" />
                <button class="btn btn-primary btn-sm" onClick={handleAddMaterial}>Add</button>
                <button class="btn btn-sm" onClick={() => setShowAddMaterial(false)}>Cancel</button>
              </div>
            ) : (
              <button class="btn btn-sm" onClick={() => setShowAddMaterial(true)}>
                <Plus size={14} /> Add Material
              </button>
            )}
          </div>

          <JobAssets jobId={job.id} customerId={job.customer_id} role={user?.role} />

          {/* Activity / Notes */}
          <div class="detail-section">
            <h3>Activity</h3>
            <div class="note-input-row">
              <input
                type="text"
                value={noteText}
                onInput={(e) => setNoteText((e.target as HTMLInputElement).value)}
                placeholder="Add a note..."
                aria-label="Add a note"
                onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
              />
              <button class="btn btn-primary btn-sm" onClick={handleAddNote}>
                <Send size={14} />
              </button>
            </div>
            <div class="notes-list">
              {(job.job_notes || []).map((note) => (
                <div key={note.id} class="note-item">
                  <div class="note-content">{note.content}</div>
                  <div class="note-meta">
                    <span>{new Date(note.created_at).toLocaleString()}</span>
                    {isAgent && (
                      <button class="btn-icon danger" onClick={() => deleteJobNote(note.id)}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <NotificationHistory entityType="job" entityId={job.id} role={user?.role} />
          {user?.role !== "technician" && (
            <p class="text-muted" style={{ fontSize: 12, marginTop: -8 }}>
              To change what this customer is notified about, use{" "}
              <span class="link" onClick={() => navigate(`/customers/${job.customer_id}`)}>their notification preferences</span>.
            </p>
          )}
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Status</h4>
            <p class="text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
              Current: {STATUS_LABELS[job.status] || job.status}
            </p>
            {allowedTransitions.length === 0 ? (
              <p class="text-muted">No further transitions available</p>
            ) : (
              <div class="status-buttons">
                {allowedTransitions.map((s) => (
                  <button
                    key={s}
                    class="status-btn"
                    disabled={s === "completed" && completion !== null && !completion.allowed}
                    title={s === "completed" && completion !== null && !completion.allowed
                      ? completion.requirements.filter((r) => !r.satisfied).map((r) => r.label).join("; ")
                      : undefined}
                    onClick={() => setPendingTransition(s)}
                  >
                    {STATUS_LABELS[s] || s.replace("_", " ")}
                  </button>
                ))}
              </div>
            )}
            {completion && !completion.allowed && allowedTransitions.includes("completed") && (
              <p class="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                Cannot complete yet: {completion.requirements.filter((r) => !r.satisfied).map((r) => r.label).join("; ")}
              </p>
            )}
          </div>

          {allowedTransitions.includes("completed") && (
            <JobCompliance job={job} completion={completion} onChange={refreshCompletion} />
          )}

          <JobMaintenanceReport jobId={job.id} customerId={job.customer_id} canAssociate={!isFieldTechnician} />

          {!isFieldTechnician && (
            <div class="detail-sidebar-section">
              <h4>Assign Technician</h4>
              <select
                aria-label="Assign technician"
                value={job.technician_id || ""}
                onChange={(e) => {
                  const val = (e.target as HTMLSelectElement).value;
                  const id = val ? parseInt(val, 10) : null;
                  const name = id ? (technicianLookup.find((t) => t.id === id)?.name || "Unknown") : "Unassigned";
                  setPendingTechnician({ id, name });
                }}
              >
                <option value="">Unassigned</option>
                {technicianLookup.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {job.is_recurring === 1 && (
            <div class="detail-sidebar-section">
              <h4>Recurring</h4>
              <p class="text-muted">{job.recurrence_interval || "Not set"}</p>
            </div>
          )}

          {job.job_type !== "STANDARD" && (
            <div class="detail-sidebar-section">
              <h4><BadgeCheck size={14} style={{ verticalAlign: "text-bottom" }} /> Rebate Eligibility</h4>
              {job.job_type === "CLEANBC" && (
                job.eligibility_code ? (
                  editingEligibility ? (
                    <div class="form-grid">
                      <div class="form-group full-width">
                        <label for="job-eligibility-code">Eligibility Code</label>
                        <input id="job-eligibility-code" type="text" value={editCode} onInput={(e) => setEditCode((e.target as HTMLInputElement).value)} />
                      </div>
                      <div class="form-group full-width">
                        <label for="job-eligibility-expiry">Expiry</label>
                        <input id="job-eligibility-expiry" type="date" value={editExpiry} onChange={(e) => setEditExpiry((e.target as HTMLInputElement).value)} />
                      </div>
                      <div class="form-group full-width" style={{ display: "flex", gap: 8 }}>
                        <button class="btn btn-sm" onClick={() => setEditingEligibility(false)}>Cancel</button>
                        <button class="btn btn-sm btn-primary" onClick={() => setPendingEligibilityEdit(true)}>Save</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p class="text-muted" style={{ marginBottom: 4 }}>
                        Code: <code>{job.eligibility_code}</code><br />
                        Expires: {job.eligibility_code_expiry}
                      </p>
                      {canManageRebate && (
                        <button class="btn btn-sm" onClick={startEditEligibility}>Correct Code / Expiry</button>
                      )}
                    </>
                  )
                ) : (
                  <p class="text-muted">No eligibility code yet — set when transitioning to Eligibility Approved.</p>
                )
              )}

              {canManageRebate && (
                <button class="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setPendingCheck(true)}>
                  Run Eligibility Check
                </button>
              )}

              {checkResult && (
                <div class="inline-notice" style={{ marginTop: 8 }}>
                  <strong>{checkResult.allowed === null ? "Cannot fully evaluate" : checkResult.allowed ? "Appears eligible" : "Does not appear eligible"}</strong>
                  <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                    {checkResult.criteria.map((c) => (
                      <li key={c.key}>{c.label}: {c.satisfied === null ? "unknown" : c.satisfied ? "OK" : "not met"} — {c.detail}</li>
                    ))}
                  </ul>
                </div>
              )}

              {rebateAudit.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <p class="text-muted" style={{ marginBottom: 4, fontSize: 12 }}>Audit history</p>
                  <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: 12 }}>
                    {rebateAudit.slice(0, 5).map((a) => (
                      <li key={a.id} class="text-muted">
                        {a.event_type.replace("_", " ")} — {new Date(a.created_at).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div class="detail-sidebar-section">
            <h4>Google Calendar</h4>
            <GoogleSyncBadge jobId={job.id} />
          </div>
        </div>
      </div>

      {allowedTransitions.length > 0 && primaryTransition && (
        <div class="tech-sticky-actions">
          <button
            type="button"
            class="btn btn-primary tech-sticky-btn"
            disabled={primaryTransition === "completed" && completion !== null && !completion.allowed}
            onClick={() => setPendingTransition(primaryTransition)}
          >
            {primaryTransition === "completed"
              ? completion && !completion.allowed
                ? `Complete Job — ${incompleteCount} requirement${incompleteCount === 1 ? "" : "s"} remaining`
                : "✓ Ready to Complete"
              : `Mark as ${STATUS_LABELS[primaryTransition] || primaryTransition.replace("_", " ")}`}
          </button>
        </div>
      )}

      {pendingTransition && (
        <div class="modal-overlay" onClick={() => !transitioning && setPendingTransition(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Change status?</h2>
              <button class="btn-icon" onClick={() => setPendingTransition(null)}><X size={18} /></button>
            </div>
            <div class="confirm-body">
              <p>
                Move job <strong>{job.identifier}</strong> from{" "}
                <strong>{STATUS_LABELS[job.status] || job.status}</strong> to{" "}
                <strong>{STATUS_LABELS[pendingTransition] || pendingTransition}</strong>?
              </p>
              {pendingTransition === "eligibility_approved" && (
                <div class="form-grid">
                  <div class="form-group full-width">
                    <label for="job-status-elig-code">Eligibility Code *</label>
                    <input
                      id="job-status-elig-code" type="text" value={eligCode}
                      onInput={(e) => setEligCode((e.target as HTMLInputElement).value)}
                      required
                    />
                  </div>
                  <div class="form-group full-width">
                    <label for="job-status-elig-expiry">Eligibility Code Expiry *</label>
                    <input
                      id="job-status-elig-expiry" type="date" value={eligExpiry}
                      onChange={(e) => setEligExpiry((e.target as HTMLInputElement).value)}
                      required
                    />
                  </div>
                </div>
              )}
              {pendingTransition === "completed" && completion && !completion.allowed && (
                <div class="inline-error">
                  Cannot complete yet: {completion.requirements.filter((r) => !r.satisfied).map((r) => r.label).join("; ")}
                </div>
              )}
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingTransition(null)} disabled={transitioning}>Cancel</button>
              <button
                type="button" class="btn btn-primary"
                disabled={transitioning || transitionBlocked}
                onClick={handleConfirmTransition}
              >
                {transitioning ? "Please wait..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCreateInvoice && (
        <ConfirmDialog
          title="Create invoice for this job?"
          message={`Generate an invoice for job ${job.identifier}? If an active invoice already exists for this job, the existing one will be shown instead — this never creates a duplicate.`}
          confirmLabel="Create Invoice"
          submitting={creatingInvoice}
          onConfirm={handleConfirmCreateInvoice}
          onClose={() => setPendingCreateInvoice(false)}
        />
      )}

      {pendingTechnician && (
        <ConfirmDialog
          title="Reassign technician?"
          message={`Assign job ${job.identifier} to ${pendingTechnician.name}?`}
          confirmLabel="Reassign"
          submitting={reassigning}
          onConfirm={handleConfirmReassign}
          onClose={() => setPendingTechnician(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this job?"
          message={`Job ${job.identifier} and all of its notes, checklist items, and materials will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={handleConfirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}

      {pendingCheck && (
        <ConfirmDialog
          title="Run eligibility check?"
          message={`Evaluate ${job.identifier}'s customer against current ${JOB_TYPE_LABELS[job.job_type]} thresholds and record the result? This is logged permanently to the job's audit history.`}
          confirmLabel="Run Check"
          submitting={checking}
          onConfirm={handleConfirmCheck}
          onClose={() => setPendingCheck(false)}
        />
      )}

      {pendingEligibilityEdit && (
        <ConfirmDialog
          title="Save eligibility code correction?"
          message={`Update the eligibility code to "${editCode}" and expiry to "${editExpiry}"? This is logged permanently to the job's audit history.`}
          confirmLabel="Save"
          submitting={savingEligibility}
          onConfirm={handleConfirmEligibilityEdit}
          onClose={() => setPendingEligibilityEdit(false)}
        />
      )}

      {showScheduleEdit && (
        <ScheduleEditModal job={job} onClose={() => setShowScheduleEdit(false)} />
      )}
    </div>
  );
}
