import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { Search, X } from "lucide-preact";
import type { Customer } from "../types";

/**
 * Reusable searchable customer combobox — built specifically because loading
 * every customer into a native <select> (the existing customerLookup /
 * GET /api/customers/all pattern create-job.tsx uses) doesn't scale to a
 * large customer base. This calls the EXISTING paginated + search-capable
 * GET /api/customers?search=&limit= endpoint (already supports name/email/
 * phone/address matching — see listCustomers in index.ts) rather than
 * introducing a new backend search capability.
 */
export function CustomerSearchSelect({
  value, valueLabel, onChange, excludeId, placeholder = "Search customer by name, phone, or email...",
}: {
  value: number | null;
  /** Known display label for `value` (e.g. when editing and a customer is
   *  already selected) — avoids an extra fetch just to render the chosen state. */
  valueLabel?: string;
  onChange: (id: number | null, label: string) => void;
  /** Excludes this customer id from results — used to prevent self-referral. */
  excludeId?: number;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [selectedLabel, setSelectedLabel] = useState(valueLabel || "");
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => { setSelectedLabel(valueLabel || ""); }, [valueLabel, value]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const runSearch = (q: string) => {
    clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ customers: Customer[] }>("GET", `/api/customers?search=${encodeURIComponent(q)}&limit=8`);
        setResults(res.customers.filter((c) => c.id !== excludeId));
        setHighlighted(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250) as unknown as number;
  };

  const selectCustomer = (c: Customer) => {
    const label = `${c.name}${c.phone ? ` — ${c.phone}` : ""}`;
    setSelectedLabel(label);
    setQuery("");
    setResults([]);
    setOpen(false);
    onChange(c.id, label);
  };

  const clearSelection = () => {
    setSelectedLabel("");
    setQuery("");
    onChange(null, "");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); selectCustomer(results[highlighted]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div class="customer-select" ref={containerRef}>
      {value !== null && selectedLabel ? (
        <div class="customer-select-chosen">
          <span>{selectedLabel}</span>
          <button type="button" class="btn-icon" aria-label="Clear selected customer" onClick={clearSelection}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <div class="customer-select-input-row">
          <Search size={14} class="customer-select-icon" aria-hidden="true" />
          <input
            type="text"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setQuery(v);
              setOpen(true);
              runSearch(v);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
          />
        </div>
      )}
      {open && value === null && query.trim() && (
        <div class="customer-select-dropdown" role="listbox">
          {loading ? (
            <div class="customer-select-empty">Searching...</div>
          ) : results.length === 0 ? (
            <div class="customer-select-empty">No matching customers</div>
          ) : (
            results.map((c, i) => (
              <button
                type="button" key={c.id}
                class={`customer-select-option ${i === highlighted ? "highlighted" : ""}`}
                role="option" aria-selected={i === highlighted}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectCustomer(c)}
              >
                <span class="text-bold">{c.name}</span>
                {c.phone && <span class="text-muted"> — {c.phone}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
