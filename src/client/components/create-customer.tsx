import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useReferenceData } from "../reference-data";
import { ConfirmDialog } from "./confirm-dialog";
import { CustomerSearchSelect } from "./customer-search-select";
import { X } from "lucide-preact";

export function CreateCustomer({ onClose }: { onClose: () => void }) {
  const { addCustomer, setError } = useApp();
  const { referralSources, heatingSources } = useReferenceData();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [notes, setNotes] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [referralName, setReferralName] = useState("");
  const [referredById, setReferredById] = useState<number | null>(null);
  const [referredByLabel, setReferredByLabel] = useState("");

  const [isRebateCustomer, setIsRebateCustomer] = useState(false);
  const [houseSize, setHouseSize] = useState("");
  const [heatingSource, setHeatingSource] = useState("");
  const [adults, setAdults] = useState("");
  const [children, setChildren] = useState("");
  const [income, setIncome] = useState("");

  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleReferralSourceChange = (value: string) => {
    setReferralSource(value);
    // Changing away from a source with a conditional field clears that
    // field's stale value immediately — it must never be silently submitted
    // for a since-changed source. The server enforces this independently too
    // (see src/server/customers.ts), this is just so the UI never shows or
    // sends a value that no longer applies.
    if (value !== "Referral") setReferralName("");
    if (value !== "Existing Customer") { setReferredById(null); setReferredByLabel(""); }
  };

  const requestSubmit = (e: Event) => {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    if (referralSource === "Referral" && !referralName.trim()) { setError("Referral Name is required"); return; }
    if (referralSource === "Existing Customer" && referredById === null) { setError("Select the customer who made the referral"); return; }
    setPendingSubmit(true);
  };

  const confirmSubmit = async () => {
    setSubmitting(true);
    try {
      await addCustomer({
        name: name.trim(), email, phone, address, city, state, zip, notes,
        referral_source: referralSource,
        referral_name: referralName,
        referred_by_customer_id: referredById,
        house_size: isRebateCustomer && houseSize ? parseInt(houseSize, 10) : null,
        primary_heating_source: isRebateCustomer ? heatingSource : "",
        number_of_adults: isRebateCustomer && adults ? parseInt(adults, 10) : null,
        number_of_children: isRebateCustomer && children ? parseInt(children, 10) : null,
        household_income: isRebateCustomer && income ? parseFloat(income) : null,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>New Customer</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={requestSubmit}>
          <div class="modal-body-scroll">
            <div class="form-section">
              <div class="form-section-heading">Customer Information</div>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Name *</label>
                  <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required placeholder="John Smith" />
                </div>
                <div class="form-group">
                  <label>Email</label>
                  <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="john@example.com" />
                </div>
                <div class="form-group">
                  <label>Phone</label>
                  <input type="tel" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} placeholder="(555) 123-4567" />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Address</div>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Address</label>
                  <input type="text" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} placeholder="123 Main St" />
                </div>
                <div class="form-group">
                  <label>City</label>
                  <input type="text" value={city} onInput={(e) => setCity((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Province/State</label>
                  <input type="text" value={state} onInput={(e) => setState((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Postal Code</label>
                  <input type="text" value={zip} onInput={(e) => setZip((e.target as HTMLInputElement).value)} />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Referral</div>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Referral Source</label>
                  <select value={referralSource} onChange={(e) => handleReferralSourceChange((e.target as HTMLSelectElement).value)}>
                    <option value="">Select...</option>
                    {referralSources.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {referralSource === "Referral" && (
                  <div class="form-group full-width">
                    <label>Referral Name *</label>
                    <input
                      type="text" value={referralName}
                      onInput={(e) => setReferralName((e.target as HTMLInputElement).value)}
                      placeholder="Jane Smith" required
                    />
                  </div>
                )}
                {referralSource === "Existing Customer" && (
                  <div class="form-group full-width">
                    <label>Referred By Customer *</label>
                    <CustomerSearchSelect
                      value={referredById}
                      valueLabel={referredByLabel}
                      onChange={(id, label) => { setReferredById(id); setReferredByLabel(label); }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Notes</div>
              <div class="form-grid">
                <div class="form-group full-width">
                  <textarea rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Rebate Program</div>
              <label class="checkbox-row">
                <input
                  type="checkbox" checked={isRebateCustomer}
                  onChange={(e) => setIsRebateCustomer((e.target as HTMLInputElement).checked)}
                />
                This is a rebate program customer (CleanBC / BC Hydro)
              </label>

              {isRebateCustomer && (
                <div class="form-grid" style={{ marginTop: 12 }}>
                  <div class="form-group">
                    <label>House Size (sq ft)</label>
                    <input type="number" min="0" value={houseSize} onInput={(e) => setHouseSize((e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="form-group">
                    <label>Primary Heating Source</label>
                    <select value={heatingSource} onChange={(e) => setHeatingSource((e.target as HTMLSelectElement).value)}>
                      <option value="">Select...</option>
                      {heatingSources.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Number of Adults</label>
                    <input type="number" min="0" value={adults} onInput={(e) => setAdults((e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="form-group">
                    <label>Number of Children (&lt;18)</label>
                    <input type="number" min="0" value={children} onInput={(e) => setChildren((e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="form-group">
                    <label>Household Income Level ($/yr)</label>
                    <input type="number" min="0" value={income} onInput={(e) => setIncome((e.target as HTMLInputElement).value)} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating..." : "Create Customer"}
            </button>
          </div>
        </form>
      </div>
    </div>

    {pendingSubmit && (
      <ConfirmDialog
        title="Create this customer?"
        message={`Create "${name.trim()}"${isRebateCustomer ? " with the rebate profile you entered" : ""}?`}
        confirmLabel="Create"
        submitting={submitting}
        onConfirm={confirmSubmit}
        onClose={() => setPendingSubmit(false)}
      />
    )}
    </>
  );
}
