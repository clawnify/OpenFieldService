// Fictional, local-only screenshot data. Run against a NEW isolated Wrangler DB.
// node scripts/setup-db.mjs /tmp/ofs-previews
// wrangler dev --local --port 8787 --persist-to /tmp/ofs-previews
// node scripts/seed-preview.mjs
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:8787';
async function api(method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const stats = await api('GET', '/stats');
if (stats.customers || stats.jobs || stats.technicians) throw new Error('Preview seed requires an empty database. Use a new --persist-to directory.');
const day = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const names = ['Juniper House', 'Maple & Main', 'Westhaven Studios', 'Cedar Park School', 'Harbor Coffee', 'Oakridge Apartments', 'Riverbend Clinic', 'Pine Street Market'];
const customers = [];
for (const [i, name] of names.entries()) customers.push(await api('POST', '/customers', {
  name, email: `facilities${i + 1}@example.com`, phone: `(512) 555-01${String(i + 10)}`,
  address: `${120 + i * 30} ${['Juniper Lane', 'Maple Avenue', 'Westhaven Drive', 'Cedar Road', 'Harbor Street', 'Oakridge Way', 'Riverbend Road', 'Pine Street'][i]}`,
  city: 'Austin', state: 'TX', zip: '78701', notes: 'Fictional preview customer. Contact reception before arrival.',
}));
const techs = [];
for (const [i, name] of ['Alex Morgan', 'Jordan Lee', 'Sam Rivera', 'Casey Chen'].entries()) techs.push(await api('POST', '/technicians', {
  name, email: `technician${i + 1}@example.com`, phone: `(512) 555-012${i}`, color: ['#528575', '#6f79ac', '#c18a51', '#a06c8b'][i],
}));
const services = (await api('GET', '/service-types')).service_types;
const maintenance = services.find(s => s.name === 'Maintenance');
const emergency = services.find(s => s.name === 'Emergency');
const site = await api('POST', `/customers/${customers[0].id}/sites`, {
  name: 'Juniper House · North building', address: '120 Juniper Lane, Austin, TX', contact_name: 'Taylor Brooks',
  contact_phone: '(512) 555-0142', contact_email: 'facilities1@example.com', timezone: 'America/Chicago',
  access_instructions: 'Check in at reception. Roof access via the east stairwell.', safety_notes: 'Isolate power before opening the unit.',
});
const asset = await api('POST', `/customers/${customers[0].id}/assets`, {
  site_id: site.id, name: 'Rooftop air handler', serial_number: 'AHU-JH-2024-018', manufacturer: 'Northstar', model: 'Aero 450',
  installation_date: '2024-03-12', commissioning_date: '2024-03-14', warranty_start: '2024-03-14', warranty_end: '2027-03-14',
  notes: 'Serves floors 1–3. Replace filters at each quarterly visit.',
});
await api('POST', `/customers/${customers[0].id}/assets`, {
  site_id: site.id, name: 'Lobby heat pump', serial_number: 'HP-JH-2024-006', manufacturer: 'Northstar', model: 'Comfort 80',
  installation_date: '2024-03-12', warranty_end: '2027-03-14',
});
const jobs = [];
for (let i = 0; i < 24; i++) {
  const past = i < 8;
  const offset = past ? -8 + i : i < 14 ? 0 : Math.floor((i - 14) / 2) + 1;
  const service = i === 10 ? emergency : i % 3 === 0 ? maintenance : services[i % services.length];
  const job = await api('POST', '/jobs', {
    customer_id: customers[i % customers.length].id, technician_id: techs[i % techs.length].id, service_type_id: service.id,
    ...(i === 0 || i === 8 ? { asset_id: asset.id } : {}),
    scheduled_date: day(offset), scheduled_time: ['08:30', '09:00', '10:30', '11:00', '13:30', '15:00'][i % 6],
    status: past ? 'completed' : i === 8 ? 'in_progress' : i % 2 ? 'confirmed' : 'scheduled',
    priority: i === 10 ? 'urgent' : 'normal', duration: service.default_duration, price: service.default_price,
    notes: i === 8 ? 'Quarterly maintenance. Check airflow on the third floor and replace return-air filters.' : 'Confirm arrival with the site contact. Record readings before leaving.',
  });
  jobs.push(job);
}
const job = jobs[8];
for (const label of ['Isolate power and inspect wiring', 'Replace return-air filters', 'Check airflow and temperature differential', 'Record readings and notify the site contact']) await api('POST', `/jobs/${job.id}/checklist`, { label });
const checklist = (await api('GET', `/jobs/${job.id}`)).job.checklist;
for (const item of checklist.slice(0, 2)) await api('PUT', `/checklist/${item.id}`, { checked: 1 });
const material = (await api('GET', '/materials')).materials.find(m => m.name === 'Filter Replacement');
await api('POST', `/jobs/${job.id}/materials`, { material_id: material.id, quantity: 2 });
await api('POST', `/jobs/${jobs[0].id}/notes`, { content: 'Replaced drive belt. Unit tested under load; vibration is within range.' });
await api('POST', `/jobs/${job.id}/notes`, { content: 'On site at 10:30. Filters replaced; checking supply airflow on floor 3.' });
const invoices = [];
for (let i = 0; i < 8; i++) {
  const invoice = await api('POST', '/invoices', {
    customer_id: customers[i].id, job_id: jobs[i].id, tax_rate: 8.25, due_date: day(i < 2 ? -3 : 14),
    notes: 'Thank you for choosing us. Please include the invoice number with your payment.',
    lines: [{ description: 'Preventive maintenance visit', quantity: 1, unit_price: 125 }, { description: 'Return-air filter replacement', quantity: 2, unit_price: 25 }],
  });
  await api('PUT', `/invoices/${invoice.id}`, { status: i < 2 ? 'overdue' : i < 5 ? 'paid' : 'sent', ...(i >= 2 && i < 5 ? { paid_date: day(-1) } : {}) });
  invoices.push(invoice);
}
const routes = { dashboard: '/', schedule: '/schedule', jobs: '/jobs', job: `/jobs/${job.id}`, customers: '/customers', customer: `/customers/${customers[0].id}`, equipment: `/assets/${asset.id}`, technicians: '/technicians', services: '/services', materials: '/materials', invoices: '/invoices', invoice: `/invoices/${invoices[5].id}` };
writeFileSync('/tmp/openfieldservice-preview-routes.json', JSON.stringify({ date: day(), routes }, null, 2) + '\n');
console.log(JSON.stringify({ date: day(), routes }, null, 2));
