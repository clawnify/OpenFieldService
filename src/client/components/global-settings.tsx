import { useState, useEffect, useCallback } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { CompanyProfileSettings } from "./company-profile";
import { TaxJurisdictionSettings } from "./tax-jurisdiction-settings";
import {
  SETTINGS_CATALOG, getSettingMeta, formatSettingValue, formatSettingDate,
  type SettingCatalogEntry,
} from "../settings-catalog";
import { Plus, History, Trash2, Settings as SettingsIcon, X, Pencil, HelpCircle } from "lucide-preact";
import type { GlobalSetting, SettingDataType } from "../types";

const DATA_TYPES: SettingDataType[] = ["string", "number", "boolean", "json"];

interface RawForm {
  key: string;
  value: string;
  data_type: SettingDataType;
  category: string;
  description: string;
}

const EMPTY_RAW_FORM: RawForm = { key: "", value: "", data_type: "string", category: "general", description: "" };

/** Groups the catalog by display category, then by group within a category
 *  (e.g. "Rebate Programs" -> "CleanBC" / "BC Hydro"), independent of the
 *  raw backend `category` string — a purely presentational grouping. */
function groupCatalog() {
  const byCategory = new Map<string, Map<string, SettingCatalogEntry[]>>();
  for (const entry of SETTINGS_CATALOG) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, new Map());
    const groupKey = entry.group ?? "";
    const groups = byCategory.get(entry.category)!;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(entry);
  }
  return byCategory;
}

export function GlobalSettings() {
  const { setError } = useApp();
  const [settings, setSettings] = useState<GlobalSetting[]>([]);
  const [loading, setLoading] = useState(true);

  // Threshold (number / money_cents) editing
  const [editingThreshold, setEditingThreshold] = useState<SettingCatalogEntry | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [pendingThreshold, setPendingThreshold] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Option list (json array) editing
  const [editingOptions, setEditingOptions] = useState<SettingCatalogEntry | null>(null);
  const [optionsDraft, setOptionsDraft] = useState<string[]>([]);
  const [newOptionText, setNewOptionText] = useState("");
  const [pendingOptions, setPendingOptions] = useState(false);
  const [savingOptions, setSavingOptions] = useState(false);

  // Select (fixed choice list, e.g. Business Timezone) editing
  const [editingSelect, setEditingSelect] = useState<SettingCatalogEntry | null>(null);
  const [selectDraft, setSelectDraft] = useState("");
  const [pendingSelect, setPendingSelect] = useState(false);
  const [savingSelect, setSavingSelect] = useState(false);

  // Retire (works for both catalog and custom settings)
  const [retireTarget, setRetireTarget] = useState<GlobalSetting | null>(null);
  const [retiring, setRetiring] = useState(false);

  // History
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<GlobalSetting[]>([]);

  // Advanced/custom setting (raw form — the escape hatch for anything not
  // in the catalog; this is the entire old page's create/edit UI, kept
  // intact but no longer the primary experience)
  const [rawForm, setRawForm] = useState<RawForm | null>(null);
  const [rawIsNew, setRawIsNew] = useState(true);
  const [pendingRaw, setPendingRaw] = useState(false);
  const [savingRaw, setSavingRaw] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ settings: GlobalSetting[] }>("GET", "/api/settings");
      setSettings(res.settings);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const findCurrent = (key: string) => settings.find((s) => s.key === key);
  const catalogKeys = new Set(SETTINGS_CATALOG.map((e) => e.key));
  const customSettings = settings.filter((s) => !catalogKeys.has(s.key));

  // ── Threshold editing ──

  const startEditThreshold = (entry: SettingCatalogEntry) => {
    const current = findCurrent(entry.key);
    if (current) {
      thresholdDisplayDraft(entry, current.value);
    } else {
      setThresholdDraft("");
    }
    setEditingThreshold(entry);
  };

  function thresholdDisplayDraft(entry: SettingCatalogEntry, rawValue: string) {
    if (entry.kind === "money_cents") {
      const cents = Number(rawValue);
      setThresholdDraft(Number.isFinite(cents) ? (cents / 100).toFixed(2) : "");
    } else {
      setThresholdDraft(rawValue);
    }
  }

  const confirmThreshold = async () => {
    if (!editingThreshold) return;
    setSavingThreshold(true);
    try {
      let storedValue: string;
      if (editingThreshold.kind === "text") {
        if (!thresholdDraft.trim()) throw new Error("Enter a value");
        storedValue = thresholdDraft.trim();
      } else {
        const numeric = parseFloat(thresholdDraft);
        if (!Number.isFinite(numeric)) throw new Error("Enter a valid number");
        storedValue = editingThreshold.kind === "money_cents" ? String(Math.round(numeric * 100)) : String(numeric);
      }
      await api("POST", "/api/settings", {
        key: editingThreshold.key,
        value: storedValue,
        data_type: editingThreshold.dataType,
        category: editingThreshold.category,
        description: editingThreshold.description,
      });
      setEditingThreshold(null);
      setPendingThreshold(false);
      await fetchSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingThreshold(false);
    }
  };

  // ── Option list editing ──

  const startEditOptions = (entry: SettingCatalogEntry) => {
    const current = findCurrent(entry.key);
    if (current) {
      try {
        const parsed = JSON.parse(current.value);
        setOptionsDraft(Array.isArray(parsed) ? parsed.map(String) : []);
      } catch {
        setOptionsDraft([]);
      }
    } else {
      setOptionsDraft([]);
    }
    setNewOptionText("");
    setEditingOptions(entry);
  };

  const addOption = () => {
    const text = newOptionText.trim();
    if (!text) return;
    setOptionsDraft([...optionsDraft, text]);
    setNewOptionText("");
  };

  const removeOption = (index: number) => {
    setOptionsDraft(optionsDraft.filter((_, i) => i !== index));
  };

  const updateOption = (index: number, value: string) => {
    setOptionsDraft(optionsDraft.map((o, i) => (i === index ? value : o)));
  };

  const confirmOptions = async () => {
    if (!editingOptions) return;
    setSavingOptions(true);
    try {
      const cleaned = optionsDraft.map((o) => o.trim()).filter(Boolean);
      await api("POST", "/api/settings", {
        key: editingOptions.key,
        value: JSON.stringify(cleaned),
        data_type: "json",
        category: editingOptions.category,
        description: editingOptions.description,
      });
      setEditingOptions(null);
      setPendingOptions(false);
      await fetchSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingOptions(false);
    }
  };

  // ── Select editing (fixed choice list) ──

  const startEditSelect = (entry: SettingCatalogEntry) => {
    const current = findCurrent(entry.key);
    setSelectDraft(current?.value ?? entry.options?.[0]?.value ?? "");
    setEditingSelect(entry);
  };

  const confirmSelect = async () => {
    if (!editingSelect) return;
    setSavingSelect(true);
    try {
      await api("POST", "/api/settings", {
        key: editingSelect.key,
        value: selectDraft,
        data_type: editingSelect.dataType,
        category: editingSelect.category,
        description: editingSelect.description,
      });
      setEditingSelect(null);
      setPendingSelect(false);
      await fetchSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingSelect(false);
    }
  };

  // ── Retire ──

  const confirmRetire = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    try {
      await api("DELETE", `/api/settings/${encodeURIComponent(retireTarget.key)}`);
      setRetireTarget(null);
      await fetchSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetiring(false);
    }
  };

  // ── History ──

  const openHistory = async (key: string) => {
    setHistoryKey(key);
    try {
      const res = await api<{ history: GlobalSetting[] }>("GET", `/api/settings/${encodeURIComponent(key)}/history`);
      setHistory(res.history);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── Advanced/custom raw setting (unchanged behavior from before this UI pass) ──

  const openCreateCustom = () => { setRawForm({ ...EMPTY_RAW_FORM }); setRawIsNew(true); };
  const openEditCustom = (s: GlobalSetting) => {
    setRawForm({ key: s.key, value: s.value, data_type: s.data_type, category: s.category, description: s.description });
    setRawIsNew(false);
  };

  const validateRawForm = (f: RawForm): string | null => {
    if (!f.key.trim()) return "Key is required";
    if (f.data_type === "number" && !Number.isFinite(Number(f.value))) return "Value must be a number";
    if (f.data_type === "boolean" && f.value !== "true" && f.value !== "false") return "Value must be true or false";
    if (f.data_type === "json") {
      try { JSON.parse(f.value); } catch { return "Value must be valid JSON"; }
    }
    return null;
  };

  const requestRawSubmit = (e: Event) => {
    e.preventDefault();
    if (!rawForm) return;
    const err = validateRawForm(rawForm);
    if (err) { setError(err); return; }
    setPendingRaw(true);
  };

  const confirmRawSubmit = async () => {
    if (!rawForm) return;
    setSavingRaw(true);
    try {
      await api("POST", "/api/settings", {
        key: rawForm.key.trim(),
        value: rawForm.value,
        data_type: rawForm.data_type,
        category: rawForm.category.trim() || "general",
        description: rawForm.description,
      });
      setRawForm(null);
      setPendingRaw(false);
      await fetchSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRaw(false);
    }
  };

  const grouped = groupCatalog();

  return (
    <div class="page">
      <div class="page-header">
        <h1><SettingsIcon size={20} style={{ verticalAlign: "text-bottom" }} /> Global Settings</h1>
      </div>
      <p class="text-muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Business rules and configurable options used across Field Scheduler.
        Changing a value here takes effect immediately going forward — jobs
        already evaluated keep the rule that applied to them at the time.
      </p>

      <CompanyProfileSettings />
      <TaxJurisdictionSettings />

      {loading ? (
        <div class="empty-state"><p>Loading...</p></div>
      ) : (
        <>
          {Array.from(grouped.entries()).map(([category, groups]) => (
            <div class="settings-category" key={category}>
              <h2 class="section-title">{category}</h2>
              {Array.from(groups.entries()).map(([groupName, entries]) => (
                <div class="card settings-card" key={groupName || category}>
                  {groupName && <h3 class="settings-group-heading">{groupName}</h3>}
                  {entries.map((entry) => {
                    const current = findCurrent(entry.key);
                    if (entry.kind === "option_list") {
                      let options: string[] = [];
                      if (current) {
                        try { options = JSON.parse(current.value); } catch { options = []; }
                      }
                      return (
                        <div class="setting-row" key={entry.key}>
                          <div class="setting-row-main">
                            <div class="setting-row-label">{entry.label}</div>
                            <p class="setting-row-description">{entry.description}</p>
                            {options.length > 0 ? (
                              <div class="setting-option-chips">
                                {options.map((o) => <span class="setting-chip" key={o}>{o}</span>)}
                              </div>
                            ) : (
                              <p class="text-muted" style={{ fontSize: 12 }}>No options configured yet.</p>
                            )}
                          </div>
                          <div class="setting-row-actions">
                            <button class="btn btn-sm" onClick={() => startEditOptions(entry)}>
                              <Pencil size={13} /> Edit List
                            </button>
                            {current && (
                              <button class="btn-icon" title="Version history" onClick={() => openHistory(entry.key)}>
                                <History size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }
                    if (entry.kind === "select") {
                      return (
                        <div class="setting-row" key={entry.key}>
                          <div class="setting-row-main">
                            <div class="setting-row-label">
                              {entry.label}
                              <button
                                type="button" class="setting-help-icon" title={entry.description}
                                aria-label={`About ${entry.label}: ${entry.description}`}
                              >
                                <HelpCircle size={13} />
                              </button>
                            </div>
                            <p class="setting-row-description">{entry.description}</p>
                            {current ? (
                              <>
                                <div class="setting-row-value">{formatSettingValue(entry, current.value)}</div>
                                <p class="text-muted" style={{ fontSize: 12 }}>Effective since {formatSettingDate(current.effective_from)}</p>
                              </>
                            ) : (
                              <p class="text-muted" style={{ fontSize: 12 }}>Not configured yet.</p>
                            )}
                          </div>
                          <div class="setting-row-actions">
                            <button class="btn btn-sm" onClick={() => startEditSelect(entry)}>
                              <Pencil size={13} /> {current ? "Edit" : "Configure"}
                            </button>
                            {current && (
                              <button class="btn-icon" title="Version history" onClick={() => openHistory(entry.key)}>
                                <History size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div class="setting-row" key={entry.key}>
                        <div class="setting-row-main">
                          <div class="setting-row-label">
                            {entry.label}
                            <button
                              type="button" class="setting-help-icon" title={entry.description}
                              aria-label={`About ${entry.label}: ${entry.description}`}
                            >
                              <HelpCircle size={13} />
                            </button>
                          </div>
                          <p class="setting-row-description">{entry.description}</p>
                          {current ? (
                            <>
                              <div class="setting-row-value">{formatSettingValue(entry, current.value)}</div>
                              <p class="text-muted" style={{ fontSize: 12 }}>Effective since {formatSettingDate(current.effective_from)}</p>
                            </>
                          ) : (
                            <p class="text-muted" style={{ fontSize: 12 }}>Not configured yet.</p>
                          )}
                        </div>
                        <div class="setting-row-actions">
                          <button class="btn btn-sm" onClick={() => startEditThreshold(entry)}>
                            <Pencil size={13} /> {current ? "Edit" : "Configure"}
                          </button>
                          {current && (
                            <button class="btn-icon" title="Version history" onClick={() => openHistory(entry.key)}>
                              <History size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}

          {customSettings.length > 0 && (
            <div class="settings-category">
              <h2 class="section-title">Other Settings</h2>
              <p class="text-muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 8 }}>
                Custom settings not recognized by the business-friendly views above — shown with their raw configuration.
              </p>
              <div class="card" style={{ marginBottom: 16 }}>
                <table class="table">
                  <thead>
                    <tr><th>Key</th><th>Value</th><th>Type</th><th>Description</th><th>Effective From</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {customSettings.map((s) => (
                      <tr key={s.key} class="table-row">
                        <td class="text-bold">{s.key}</td>
                        <td><code>{s.value}</code></td>
                        <td class="text-muted">{s.data_type}</td>
                        <td class="text-muted">{s.description || "—"}</td>
                        <td class="text-muted">{formatSettingDate(s.effective_from)}</td>
                        <td>
                          <div class="action-btns">
                            <button class="btn-icon" title="Edit (publish new version)" onClick={() => openEditCustom(s)}>
                              <Pencil size={14} />
                            </button>
                            <button class="btn-icon" title="Version history" onClick={() => openHistory(s.key)}>
                              <History size={14} />
                            </button>
                            <button class="btn-icon danger" title="Retire" onClick={() => setRetireTarget(s)}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <button class="btn btn-sm" onClick={openCreateCustom}>
            <Plus size={14} /> Add Custom Setting
          </button>
        </>
      )}

      {editingThreshold && (
        <div class="modal-overlay" onClick={() => !savingThreshold && setEditingThreshold(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingThreshold.label}</h2>
              <button class="btn-icon" onClick={() => setEditingThreshold(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <p class="text-muted" style={{ fontSize: 13, marginTop: 0 }}>{editingThreshold.description}</p>
              </div>
              <div class="form-group full-width">
                <label>Value{editingThreshold.unit ? ` (${editingThreshold.unit === "$" ? "dollars" : editingThreshold.unit})` : ""} *</label>
                <input
                  type={editingThreshold.kind === "text" ? "text" : "number"} step={editingThreshold.kind === "text" ? undefined : "any"} value={thresholdDraft}
                  onInput={(e) => setThresholdDraft((e.target as HTMLInputElement).value)}
                  autoFocus required
                />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setEditingThreshold(null)} disabled={savingThreshold}>Cancel</button>
              <button
                type="button" class="btn btn-primary" disabled={savingThreshold || !thresholdDraft.trim()}
                onClick={() => setPendingThreshold(true)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingThreshold && editingThreshold && (
        <ConfirmDialog
          title={`Update ${editingThreshold.label}?`}
          message={`Set "${editingThreshold.label}" to ${formatSettingValue(editingThreshold, editingThreshold.kind === "money_cents" ? String(Math.round(parseFloat(thresholdDraft || "0") * 100)) : thresholdDraft)}, effective immediately? This is published as a new version — anything already evaluated under the previous value is unaffected.`}
          confirmLabel="Save"
          submitting={savingThreshold}
          onConfirm={confirmThreshold}
          onClose={() => setPendingThreshold(false)}
        />
      )}

      {editingOptions && (
        <div class="modal-overlay" onClick={() => !savingOptions && setEditingOptions(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingOptions.label}</h2>
              <button class="btn-icon" onClick={() => setEditingOptions(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <p class="text-muted" style={{ fontSize: 13, marginTop: 0 }}>{editingOptions.description}</p>
              </div>
              <div class="form-group full-width">
                <label>Options</label>
                <div class="setting-option-editor">
                  {optionsDraft.map((option, i) => (
                    <div class="setting-option-editor-row" key={i}>
                      <input
                        type="text" value={option} aria-label={`Option ${i + 1}`}
                        onInput={(e) => updateOption(i, (e.target as HTMLInputElement).value)}
                      />
                      <button type="button" class="btn-icon danger" title="Remove option" aria-label={`Remove ${option || `option ${i + 1}`}`} onClick={() => removeOption(i)}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div class="form-group full-width">
                <div class="setting-option-add-row">
                  <input
                    type="text" value={newOptionText} placeholder="Add an option..."
                    onInput={(e) => setNewOptionText((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
                  />
                  <button type="button" class="btn btn-sm" onClick={addOption}><Plus size={13} /> Add option</button>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setEditingOptions(null)} disabled={savingOptions}>Cancel</button>
              <button type="button" class="btn btn-primary" disabled={savingOptions} onClick={() => setPendingOptions(true)}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingOptions && editingOptions && (
        <ConfirmDialog
          title={`Update ${editingOptions.label}?`}
          message={`Publish a new version of "${editingOptions.label}" with ${optionsDraft.filter((o) => o.trim()).length} option(s)? This is effective immediately for new selections; anything already selected under the previous list is unaffected.`}
          confirmLabel="Save Changes"
          submitting={savingOptions}
          onConfirm={confirmOptions}
          onClose={() => setPendingOptions(false)}
        />
      )}

      {editingSelect && (
        <div class="modal-overlay" onClick={() => !savingSelect && setEditingSelect(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingSelect.label}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setEditingSelect(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <p class="text-muted" style={{ fontSize: 13, marginTop: 0 }}>{editingSelect.description}</p>
              </div>
              <div class="form-group full-width">
                <label htmlFor="setting-select-value">{editingSelect.label} *</label>
                <select
                  id="setting-select-value"
                  class="setting-select-input"
                  value={selectDraft}
                  onChange={(e) => setSelectDraft((e.target as HTMLSelectElement).value)}
                  autoFocus required
                >
                  {(editingSelect.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setEditingSelect(null)} disabled={savingSelect}>Cancel</button>
              <button
                type="button" class="btn btn-primary" disabled={savingSelect || !selectDraft}
                onClick={() => setPendingSelect(true)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingSelect && editingSelect && (
        <ConfirmDialog
          title={`Change ${editingSelect.label}?`}
          message={
            editingSelect.key === "BUSINESS_TIMEZONE"
              ? `This affects scheduling, Google Calendar synchronization, and time-based reminders for future operations. Existing scheduled times and already-synced Google Calendar events are not changed retroactively — only jobs created, updated, or re-synced after this change will use the new timezone.`
              : `Set "${editingSelect.label}" to ${(editingSelect.options ?? []).find((o) => o.value === selectDraft)?.label ?? selectDraft}, effective immediately? This is published as a new version — anything already evaluated under the previous value is unaffected.`
          }
          confirmLabel="Save"
          submitting={savingSelect}
          onConfirm={confirmSelect}
          onClose={() => setPendingSelect(false)}
        />
      )}

      {retireTarget && (
        <ConfirmDialog
          title="Retire this setting?"
          message={`"${getSettingMeta(retireTarget.key)?.label ?? retireTarget.key}" will stop resolving to a value from now on. Its history is kept — this does not affect anything evaluated in the past.`}
          confirmLabel="Retire"
          danger
          submitting={retiring}
          onConfirm={confirmRetire}
          onClose={() => setRetireTarget(null)}
        />
      )}

      {historyKey && (
        <div class="modal-overlay" onClick={() => setHistoryKey(null)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>History — {getSettingMeta(historyKey)?.label ?? historyKey}</h2>
              <button class="btn-icon" onClick={() => setHistoryKey(null)}><X size={18} /></button>
            </div>
            <div class="history-list">
              {history.map((h) => {
                const meta = getSettingMeta(h.key);
                const display = meta ? formatSettingValue(meta, h.value) : h.value;
                const isCurrent = h.effective_until === null;
                return (
                  <div class="history-entry" key={h.id}>
                    <div class="history-entry-label">
                      {isCurrent ? "Current" : "Previous version"}
                    </div>
                    <div class="history-entry-value">{meta ? display : <code>{display}</code>}</div>
                    <div class="text-muted" style={{ fontSize: 12 }}>
                      {isCurrent
                        ? `Effective since: ${formatSettingDate(h.effective_from)}`
                        : `Effective: ${formatSettingDate(h.effective_from)} – ${formatSettingDate(h.effective_until!)}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {rawForm && (
        <div class="modal-overlay" onClick={() => setRawForm(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{rawIsNew ? "Add Custom Setting" : `Edit "${rawForm.key}"`}</h2>
              <button class="btn-icon" onClick={() => setRawForm(null)}><X size={18} /></button>
            </div>
            <form onSubmit={requestRawSubmit}>
              <div class="form-grid">
                <div class="form-group full-width">
                  <p class="text-muted" style={{ fontSize: 12, marginTop: 0 }}>
                    For advanced/one-off configuration only. Most settings should be managed from the sections above.
                  </p>
                </div>
                <div class="form-group full-width">
                  <label>Key *</label>
                  <input
                    type="text" value={rawForm.key} disabled={!rawIsNew}
                    onInput={(e) => setRawForm({ ...rawForm, key: (e.target as HTMLInputElement).value.toUpperCase().replace(/\s+/g, "_") })}
                    placeholder="CUSTOM_SETTING_KEY" required
                  />
                </div>
                <div class="form-group">
                  <label>Data Type *</label>
                  <select
                    value={rawForm.data_type} disabled={!rawIsNew}
                    onChange={(e) => setRawForm({ ...rawForm, data_type: (e.target as HTMLSelectElement).value as SettingDataType })}
                  >
                    {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Category</label>
                  <input
                    type="text" value={rawForm.category} disabled={!rawIsNew}
                    onInput={(e) => setRawForm({ ...rawForm, category: (e.target as HTMLInputElement).value })}
                    placeholder="general"
                  />
                </div>
                <div class="form-group full-width">
                  <label>Value * {rawForm.data_type === "boolean" && "(true or false)"} {rawForm.data_type === "json" && "(JSON)"}</label>
                  <input
                    type="text" value={rawForm.value}
                    onInput={(e) => setRawForm({ ...rawForm, value: (e.target as HTMLInputElement).value })}
                    required
                  />
                </div>
                <div class="form-group full-width">
                  <label>Description</label>
                  <input
                    type="text" value={rawForm.description}
                    onInput={(e) => setRawForm({ ...rawForm, description: (e.target as HTMLInputElement).value })}
                    placeholder="What this controls and why"
                  />
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setRawForm(null)}>Cancel</button>
                <button type="submit" class="btn btn-primary">
                  {rawIsNew ? "Create Setting" : "Publish New Version"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingRaw && rawForm && (
        <ConfirmDialog
          title={rawIsNew ? "Create this setting?" : "Publish a new version?"}
          message={
            rawIsNew
              ? `Create "${rawForm.key}" = ${rawForm.value} (${rawForm.data_type}), effective immediately.`
              : `Publish a new version of "${rawForm.key}": value becomes "${rawForm.value}", effective immediately. The previous value is preserved in history and still applies to anything evaluated before now.`
          }
          confirmLabel={rawIsNew ? "Create" : "Publish"}
          submitting={savingRaw}
          onConfirm={confirmRawSubmit}
          onClose={() => setPendingRaw(false)}
        />
      )}
    </div>
  );
}
