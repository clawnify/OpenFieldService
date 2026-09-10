# OpenFieldService

A scheduling and dispatch app for field service businesses — pest control, HVAC, plumbing, cleaning, landscaping, and more.

## Features
- Job scheduling with date/time, priority, and status workflow (pending → confirmed → in progress → completed)
- Weekly calendar view with technician color coding
- Customer management with contact info, addresses, and service history
- Technician dispatch and availability tracking
- Service type catalog with default pricing and durations
- Invoicing with draft/sent/paid/overdue tracking and line items
- Materials tracking per job with costs and inventory
- Job checklists for inspections and task lists
- Dashboard with KPIs (today's schedule, upcoming jobs, revenue, outstanding invoices)

## When to use this template
Use this template when the user wants to:
- Schedule and dispatch field technicians or service workers
- Manage a service business (pest control, HVAC, plumbing, cleaning, landscaping, electrical, pool service, etc.)
- Track jobs, customers, and invoices for a field service operation
- Build an alternative to PestPac, ServiceTitan, Jobber, Housecall Pro, or Fieldwork

## Customization guide

When customizing for a specific business vertical:

**Terminology** — adapt labels to the industry:
- "Technician" → "Stylist", "Cleaner", "Inspector", "Plumber", etc.
- "Job" → "Appointment", "Service Call", "Visit", "Work Order"
- "Service Type" → keep as-is or rename to "Treatment", "Service", "Package"

**Service types** — replace the default seed data in `schema.sql` with industry-specific services:
- Pest control: General Pest Treatment, Termite Inspection, Rodent Control, Mosquito Spray, Bed Bug Treatment
- HVAC: AC Repair, Furnace Installation, Duct Cleaning, Maintenance Plan, Emergency Service
- Plumbing: Drain Cleaning, Pipe Repair, Water Heater Install, Sewer Inspection, Leak Detection
- Cleaning: House Cleaning, Deep Clean, Move-in/Move-out, Carpet Cleaning, Window Washing

**Branding** — update the sidebar title, page headings, and any hardcoded company references to use the customer's company name.

**Dashboard** — adjust KPI labels if needed (e.g. "Treatments today" instead of "Jobs today").

**Priority levels** — the default priorities (low, normal, high, urgent) work for most verticals. Only change if the business uses different terminology.
