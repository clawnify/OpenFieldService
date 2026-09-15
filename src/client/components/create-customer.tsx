import { useState } from "preact/hooks";
import { useApp } from "../context";
import { X } from "lucide-preact";

export function CreateCustomer({ onClose }: { onClose: () => void }) {
  const { addCustomer, setError } = useApp();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setSubmitting(true);
    try {
      await addCustomer({ name: name.trim(), email, phone, address, city, state, zip, notes });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>New customer</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
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
            <div class="form-group full-width">
              <label>Address</label>
              <input type="text" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} placeholder="123 Main St" />
            </div>
            <div class="form-group">
              <label>City</label>
              <input type="text" value={city} onInput={(e) => setCity((e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label>State</label>
              <input type="text" value={state} onInput={(e) => setState((e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label>ZIP</label>
              <input type="text" value={zip} onInput={(e) => setZip((e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-group full-width">
              <label>Notes</label>
              <textarea rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
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
  );
}
