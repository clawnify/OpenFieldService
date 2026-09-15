import { useState } from "preact/hooks";
import { useApp } from "../context";
import { CreateCustomer } from "./create-customer";
import { Pagination } from "./pagination";
import { Plus, Search, Trash2 } from "lucide-preact";

export function CustomerList() {
  const {
    customers, customersPag, setCustomersPage, customersSearch, setCustomersSearch,
    navigate, deleteCustomer, isAgent,
  } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Customers</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Customer
        </button>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <Search size={14} class="search-icon" />
          <input
            type="text"
            placeholder="Search customers..."
            value={customersSearch}
            onInput={(e) => setCustomersSearch((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="table-scroll">
        {customers.length === 0 ? (
          <div class="empty-state">
            <p>{customersSearch ? "No customers match your search." : "Add a customer to start scheduling service."}</p>
            <button class="btn" onClick={() => customersSearch ? setCustomersSearch("") : setShowCreate(true)}>
              {customersSearch ? "Clear search" : "Add your first customer"}
            </button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Address</th>
                <th>Jobs</th>
                {isAgent && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} class="table-row clickable" onClick={() => navigate(`/customers/${c.id}`)}>
                  <td class="text-bold">{c.name}</td>
                  <td class="text-muted">{c.phone || "—"}</td>
                  <td class="text-muted">{c.email || "—"}</td>
                  <td class="text-muted">{[c.address, c.city, c.state].filter(Boolean).join(", ") || "—"}</td>
                  <td>{c.job_count || 0}</td>
                  {isAgent && (
                    <td>
                      <button
                        class="btn-icon danger"
                        onClick={(e) => { e.stopPropagation(); deleteCustomer(c.id); }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination pag={customersPag} setPage={setCustomersPage} />
      {showCreate && <CreateCustomer onClose={() => setShowCreate(false)} />}
    </div>
  );
}
