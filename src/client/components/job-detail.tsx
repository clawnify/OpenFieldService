import { useState } from "preact/hooks";
import { useApp } from "../context";
import { JobEquipment } from "./asset-picker";
import { StatusBadge, PriorityBadge } from "./status-badge";
import { ArrowLeft, Trash2, Send, MapPin, Clock, DollarSign, User, Wrench, Plus, X, CheckSquare, Square, Package, FileText } from "lucide-preact";
import type { JobStatus } from "../types";

const ALL_STATUSES: JobStatus[] = ["scheduled", "confirmed", "in_progress", "completed", "cancelled"];

export function JobDetail() {
  const {
    selectedJob: job, navigate, updateJob, deleteJob,
    addJobNote, deleteJobNote, technicianLookup, isAgent,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
    addJobMaterial, deleteJobMaterial, materials, createInvoiceFromJob,
  } = useApp();
  const [noteText, setNoteText] = useState("");
  const [checklistText, setChecklistText] = useState("");
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [materialId, setMaterialId] = useState("");
  const [materialQty, setMaterialQty] = useState("1");

  if (!job) return null;

  const handleStatusChange = (status: JobStatus) => updateJob(job.id, { status });

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
    await addJobMaterial(job.id, materialId, parseFloat(materialQty) || 1);
    setMaterialId("");
    setMaterialQty("1");
    setShowAddMaterial(false);
  };

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/jobs")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          <button class="btn btn-primary" onClick={() => createInvoiceFromJob(job.id)}>
            <FileText size={14} /> Create Invoice
          </button>
          <button class="btn btn-danger" onClick={() => deleteJob(job.id)}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{job.identifier}</span>
            <StatusBadge status={job.status} />
            <PriorityBadge priority={job.priority} />
          </div>

          <div class="detail-meta-grid">
            <div class="detail-meta-item">
              <User size={14} />
              <span class="detail-meta-label">Customer</span>
              <span>{job.customer_name || "—"}</span>
              {job.customer_phone && <span class="text-muted">{job.customer_phone}</span>}
            </div>
            <div class="detail-meta-item">
              <MapPin size={14} />
              <span class="detail-meta-label">Address</span>
              <span>{job.address || "—"}</span>
            </div>
            <div class="detail-meta-item">
              <Clock size={14} />
              <span class="detail-meta-label">Scheduled</span>
              <span>{job.scheduled_date} at {job.scheduled_time}</span>
              <span class="text-muted">{job.duration} min</span>
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
                <span class="service-pill" style={{ borderColor: job.service_type_color || "var(--text-muted)" }}>
                  <span class="service-dot" style={{ background: job.service_type_color || "var(--text-muted)" }} />
                  {job.service_type_name}
                </span>
              </div>
            )}
            <div class="detail-meta-item">
              <User size={14} />
              <span class="detail-meta-label">Technician</span>
              {job.technician_name ? (
                <span class="tech-pill" style={{ borderColor: job.technician_color || "var(--text-muted)" }}>
                  <span class="tech-dot" style={{ background: job.technician_color || "var(--text-muted)" }} />
                  {job.technician_name}
                </span>
              ) : (
                <span class="text-muted">Unassigned</span>
              )}
            </div>
          </div>

          <section class="customer-context" aria-labelledby="customer-context-heading">
            <div class="customer-context-heading">
              <h3 id="customer-context-heading">Customer history</h3>
              <button class="btn btn-sm" onClick={() => navigate(`/customers/${job.customer_id}`)}>
                Open customer
              </button>
            </div>
            <div class="customer-context-grid">
              <div class="customer-context-item">
                <strong>{job.customer_job_count ?? 1}</strong>
                <span>Lifetime jobs</span>
              </div>
              <div class="customer-context-item">
                {job.customer_last_service_id ? (
                  <button class="customer-context-link" onClick={() => navigate(`/jobs/${job.customer_last_service_id}`)}>
                    {job.customer_last_service_identifier} · {job.customer_last_service_date}
                  </button>
                ) : (
                  <strong>None yet</strong>
                )}
                <span>Last completed service</span>
              </div>
              <div class="customer-context-item">
                <strong>${(job.customer_lifetime_revenue ?? 0).toFixed(2)}</strong>
                <span>Paid invoice revenue</span>
              </div>
            </div>
          </section>

          {job.notes && (
            <div class="detail-section">
              <h3>Notes</h3>
              <p class="detail-notes">{job.notes}</p>
            </div>
          )}

          <JobEquipment key={job.id} job={job} />

          {/* Checklist */}
          <div class="detail-section">
            <h3><CheckSquare size={16} style={{ verticalAlign: "text-bottom" }} /> Checklist</h3>
            <div class="checklist-list">
              {(job.checklist || []).map((item) => (
                <div key={item.id} class="checklist-item">
                  <button class="checklist-toggle" onClick={() => toggleChecklistItem(item.id)}>
                    {item.checked ? <CheckSquare size={16} color="var(--success)" /> : <Square size={16} />}
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
                onKeyDown={(e) => e.key === "Enter" && handleAddChecklist()}
              />
              <button class="btn btn-sm" onClick={handleAddChecklist}>
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Materials Used */}
          <div class="detail-section">
            <h3><Package size={16} style={{ verticalAlign: "text-bottom" }} /> Materials Used</h3>
            {(job.job_materials || []).length > 0 && (
              <div class="table-scroll" style={{ marginBottom: 12 }}>
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
                <select value={materialId} onChange={(e) => setMaterialId((e.target as HTMLSelectElement).value)} style={{ flex: 2 }}>
                  <option value="">Select material...</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} (${m.unit_cost}/{m.unit})</option>
                  ))}
                </select>
                <input type="number" value={materialQty} onInput={(e) => setMaterialQty((e.target as HTMLInputElement).value)} style={{ width: 70 }} min="0.1" step="0.1" />
                <button class="btn btn-sm" onClick={handleAddMaterial}>Add</button>
                <button class="btn btn-sm" onClick={() => setShowAddMaterial(false)}>Cancel</button>
              </div>
            ) : (
              <button class="btn btn-sm" onClick={() => setShowAddMaterial(true)}>
                <Plus size={14} /> Add Material
              </button>
            )}
          </div>

          {/* Activity / Notes */}
          <div class="detail-section">
            <h3>Activity</h3>
            <div class="note-input-row">
              <input
                type="text"
                value={noteText}
                onInput={(e) => setNoteText((e.target as HTMLInputElement).value)}
                placeholder="Add a note..."
                onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
              />
              <button class="btn btn-sm" onClick={handleAddNote}>
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
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Status</h4>
            <div class="status-buttons">
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  class={`status-btn ${job.status === s ? "active" : ""}`}
                  onClick={() => handleStatusChange(s)}
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>

          <div class="detail-sidebar-section">
            <h4>Assign Technician</h4>
            <select
              value={job.technician_id || ""}
              onChange={(e) => {
                const val = (e.target as HTMLSelectElement).value;
                updateJob(job.id, { technician_id: val || null });
              }}
            >
              <option value="">Unassigned</option>
              {technicianLookup.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {job.is_recurring === 1 && (
            <div class="detail-sidebar-section">
              <h4>Recurring</h4>
              <p class="text-muted">{job.recurrence_interval || "Not set"}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
