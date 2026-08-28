import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { MaintenanceServiceReport, ChecklistSection19B, MaintenanceAgreement, ChecklistTemplate, Asset } from "../types";

/**
 * Phase 19B — Technician maintenance workflow panel, embedded in Job
 * Detail. Reuses this job's own compliance RBAC (canActorAccessJobCompliance
 * server-side) — a technician only sees/edits this for their own assigned
 * job, admin/dispatcher always. Not shown at all if no maintenance report
 * exists for this job and the viewer can't create one (technician).
 *
 * Association picker (Architecture review finding, Phase 19B): the initial
 * cut created a bare report with no agreement/checklist selection, making
 * the entire Checklist Templates feature and Agreement/Membership linkage
 * unreachable from the one flow meant to use them. Fixed by letting the
 * associating dispatcher/admin pick an Agreement (its Membership is then
 * auto-derived server-side — see maintenance-service-reports.ts) and a
 * Checklist Template Version before creating the report.
 */
export function JobMaintenanceReport({ jobId, customerId, canAssociate }: { jobId: number; customerId: number; canAssociate: boolean }) {
  const [report, setReport] = useState<MaintenanceServiceReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [workPerformed, setWorkPerformed] = useState("");
  const [findings, setFindings] = useState("");
  const [recommendations, setRecommendations] = useState("");
  const [notes, setNotes] = useState("");
  const [checklistResults, setChecklistResults] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  const [agreements, setAgreements] = useState<MaintenanceAgreement[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [customerAssets, setCustomerAssets] = useState<Asset[]>([]);
  const [selectedAgreementId, setSelectedAgreementId] = useState<number | "">("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | "">("");
  const [selectedAssetId, setSelectedAssetId] = useState<number | "">("");

  const load = async () => {
    try {
      const data = await api<{ report: MaintenanceServiceReport | null }>("GET", `/api/jobs/${jobId}/maintenance-report`);
      setReport(data.report);
      if (data.report) {
        setWorkPerformed(data.report.work_performed);
        setFindings(data.report.findings);
        setRecommendations(data.report.recommendations);
        setNotes(data.report.notes);
        setChecklistResults(JSON.parse(data.report.checklist_results || "{}"));
      } else if (canAssociate) {
        const [agreementsRes, templatesRes, assetsRes] = await Promise.all([
          api<{ agreements: MaintenanceAgreement[] }>("GET", `/api/maintenance/agreements?customer_id=${customerId}&status=active`),
          api<{ templates: ChecklistTemplate[] }>("GET", "/api/maintenance/checklist-templates"),
          api<{ assets: Asset[] }>("GET", `/api/assets?customer_id=${customerId}`),
        ]);
        setAgreements(agreementsRes.agreements);
        setTemplates(templatesRes.templates);
        setCustomerAssets(assetsRes.assets);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => { load(); }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      let checklistTemplateVersionId: number | undefined;
      if (selectedTemplateId) {
        const detail = await api<{ template: { current_version_id: number | null } }>("GET", `/api/maintenance/checklist-templates/${selectedTemplateId}`);
        checklistTemplateVersionId = detail.template.current_version_id ?? undefined;
      }
      await api("POST", `/api/jobs/${jobId}/maintenance-report`, {
        agreement_id: selectedAgreementId || undefined,
        asset_id: selectedAssetId || undefined,
        checklist_template_version_id: checklistTemplateVersionId,
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveDraft = async () => {
    if (!report) return;
    setSaving(true);
    setError(null);
    try {
      await api("PUT", `/api/jobs/${jobId}/maintenance-report/${report.id}`, {
        work_performed: workPerformed, findings, recommendations, notes, checklist_results: checklistResults,
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const finalize = async () => {
    if (!report) return;
    await saveDraft();
    try {
      await api("POST", `/api/jobs/${jobId}/maintenance-report/${report.id}/finalize`, {});
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (report === undefined) return null; // still loading — avoid a flash of "no report" UI
  if (report === null) {
    if (!canAssociate) return null;
    return (
      <div class="detail-sidebar-section">
        <h4>Maintenance Report</h4>
        <p class="text-muted" style={{ fontSize: 12 }}>This job is not yet associated with a maintenance visit.</p>
        {error && <div class="inline-error" style={{ marginBottom: 8 }}>{error}</div>}
        {agreements.length > 0 && (
          <div class="form-group">
            <label for="jmr-agreement">Maintenance Agreement (optional)</label>
            <select id="jmr-agreement" value={selectedAgreementId} onChange={(e) => setSelectedAgreementId(Number((e.target as HTMLSelectElement).value) || "")}>
              <option value="">None</option>
              {agreements.map((a) => <option key={a.id} value={a.id}>{a.identifier}</option>)}
            </select>
          </div>
        )}
        {customerAssets.length > 0 && (
          <div class="form-group">
            <label for="jmr-asset">Equipment (optional)</label>
            <select id="jmr-asset" value={selectedAssetId} onChange={(e) => setSelectedAssetId(Number((e.target as HTMLSelectElement).value) || "")}>
              <option value="">None</option>
              {customerAssets.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.asset_type}</option>)}
            </select>
          </div>
        )}
        {templates.length > 0 && (
          <div class="form-group">
            <label for="jmr-template">Checklist Template (optional)</label>
            <select id="jmr-template" value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(Number((e.target as HTMLSelectElement).value) || "")}>
              <option value="">None</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <button class="btn btn-sm" onClick={create}>Add Maintenance Report</button>
      </div>
    );
  }

  const checklist: ChecklistSection19B[] = JSON.parse(report.checklist_snapshot || "[]");
  const isFinalized = report.status === "finalized";

  return (
    <div class="detail-sidebar-section">
      <h4>Maintenance Report {isFinalized ? "(Finalized)" : "(Draft)"}</h4>
      {error && <div class="inline-error" style={{ marginBottom: 8 }}>{error}</div>}

      {checklist.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {checklist.map((section, si) => (
            <div key={si}>
              <p class="text-bold">{section.title}</p>
              {section.items.map((item) => (
                <div key={item.id} class="form-group">
                  <label for={`jmr-item-${item.id}`}>{item.label}{item.required ? " *" : ""}</label>
                  {item.input_type === "PASS_FAIL" || item.input_type === "YES_NO" ? (
                    <select
                      id={`jmr-item-${item.id}`} disabled={isFinalized}
                      value={(checklistResults[item.id] as string) ?? ""}
                      onChange={(e) => setChecklistResults({ ...checklistResults, [item.id]: (e.target as HTMLSelectElement).value })}
                    >
                      <option value="">—</option>
                      {item.input_type === "PASS_FAIL" ? (<><option value="pass">Pass</option><option value="fail">Fail</option></>) : (<><option value="yes">Yes</option><option value="no">No</option></>)}
                    </select>
                  ) : (
                    <input
                      id={`jmr-item-${item.id}`} type={item.input_type === "NUMBER" || item.input_type === "MEASUREMENT" ? "text" : "text"}
                      disabled={isFinalized} value={(checklistResults[item.id] as string) ?? ""}
                      onInput={(e) => setChecklistResults({ ...checklistResults, [item.id]: (e.target as HTMLInputElement).value })}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div class="form-group">
        <label for="jmr-work-performed">Work Performed</label>
        <textarea id="jmr-work-performed" rows={3} disabled={isFinalized} value={workPerformed} onInput={(e) => setWorkPerformed((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="form-group">
        <label for="jmr-findings">Findings</label>
        <textarea id="jmr-findings" rows={2} disabled={isFinalized} value={findings} onInput={(e) => setFindings((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="form-group">
        <label for="jmr-recommendations">Recommendations</label>
        <textarea id="jmr-recommendations" rows={2} disabled={isFinalized} value={recommendations} onInput={(e) => setRecommendations((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="form-group">
        <label for="jmr-notes">Notes</label>
        <textarea id="jmr-notes" rows={2} disabled={isFinalized} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </div>

      {!isFinalized ? (
        <>
          <button class="btn btn-sm" disabled={saving} onClick={saveDraft}>{saving ? "Saving..." : "Save Draft"}</button>{" "}
          <button class="btn btn-sm btn-primary" disabled={saving || !workPerformed.trim()} onClick={finalize}>Finalize Report</button>
        </>
      ) : (
        <a class="btn btn-sm" href={`/api/jobs/${jobId}/maintenance-report/${report.id}/document`} target="_blank" rel="noopener noreferrer">View Report PDF</a>
      )}
    </div>
  );
}
