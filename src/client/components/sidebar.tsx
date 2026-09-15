import { AppNav, embedded } from "@clawnify/app/client";
import { useState } from "preact/hooks";
import { useApp } from "../context";
import { PanelLeft, CalendarClock, LayoutDashboard, Briefcase, Users, Wrench, Settings, CalendarDays, FileText, Package } from "lucide-preact";
import type { View } from "../types";

const navItems: { view: View; path: string; label: string; icon: typeof LayoutDashboard }[] = [
  { view: "dashboard", path: "/", label: "Dashboard", icon: LayoutDashboard },
  { view: "schedule", path: "/schedule", label: "Schedule", icon: CalendarDays },
  { view: "jobs", path: "/jobs", label: "Jobs", icon: Briefcase },
  { view: "customers", path: "/customers", label: "Customers", icon: Users },
  { view: "technicians", path: "/technicians", label: "Technicians", icon: Wrench },
  { view: "invoices", path: "/invoices", label: "Invoices", icon: FileText },
  { view: "materials", path: "/materials", label: "Materials", icon: Package },
  { view: "services", path: "/services", label: "Service types", icon: Settings },
];

export function Sidebar({ currentView }: { currentView: View }) {
  const { navigate, stats } = useApp();

  const [collapsed, setCollapsed] = useState(false);

  if (embedded) {
    const icons = ["home", "calendar-days", "briefcase", "users", "settings", "file-text", "package", "settings"];
    return <AppNav title="Field Service" icon="settings" active={currentView === "assets" ? "customers" : currentView}
      groups={[{ items: navItems.map((item, index) => ({
        id: item.view, label: item.label, href: item.path, icon: icons[index],
        home: item.view === "dashboard",
        count: item.view === "jobs" ? stats.jobs || undefined
          : item.view === "customers" ? stats.customers || undefined
          : item.view === "invoices" ? stats.invoices_outstanding || undefined : undefined,
      })) }]}
      onNavigate={item => navigate(item.href ?? "/")} />;
  }

  return (
    <aside class={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div class="sidebar-brand">
        <div class="sidebar-brand-icon">
          <CalendarClock size={16} />
        </div>
        <span class="sidebar-brand-name">OpenFieldService</span>
        <button class="btn-icon" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setCollapsed(!collapsed)}><PanelLeft size={16} /></button>
      </div>
      <nav class="sidebar-nav">
        <div class="sidebar-section-title">Menu</div>
        {navItems.map((item) => (
          <button
            key={item.view}
            title={item.label}
            aria-current={(currentView === item.view || (currentView === "assets" && item.view === "customers")) ? "page" : undefined}
            class={`sidebar-item ${(currentView === item.view || (currentView === "assets" && item.view === "customers")) ? "active" : ""}`}
            onClick={() => navigate(item.path)}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
            {item.view === "jobs" && stats.jobs > 0 && (
              <span class="sidebar-badge">{stats.jobs}</span>
            )}
            {item.view === "customers" && stats.customers > 0 && (
              <span class="sidebar-badge">{stats.customers}</span>
            )}
            {item.view === "invoices" && stats.invoices_outstanding > 0 && (
              <span class="sidebar-badge">{stats.invoices_outstanding}</span>
            )}
          </button>
        ))}
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-stat">
          <span class="sidebar-stat-value">{stats.today_jobs}</span>
          <span class="sidebar-stat-label">Today</span>
        </div>
        <div class="sidebar-stat">
          <span class="sidebar-stat-value">{stats.upcoming_jobs}</span>
          <span class="sidebar-stat-label">Upcoming</span>
        </div>
      </div>
    </aside>
  );
}
