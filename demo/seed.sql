-- Fictional service visits for the disposable template preview.
INSERT INTO customers (id, name, email, address, city) VALUES
 ('00000000-0000-4000-8000-000000000001', 'Juniper House', 'facilities@example.test', '120 Sample Lane', 'Austin'),
 ('00000000-0000-4000-8000-000000000002', 'Harbor Coffee', 'coffee@example.test', '240 Sample Street', 'Austin'),
 ('00000000-0000-4000-8000-000000000003', 'Westhaven Studios', 'studio@example.test', '360 Sample Avenue', 'Austin');
INSERT INTO technicians (id, name, email, color) VALUES
 ('00000000-0000-4000-8000-000000000011', 'Alex Morgan', 'alex@example.test', '#528575'),
 ('00000000-0000-4000-8000-000000000012', 'Jordan Lee', 'jordan@example.test', '#6f79ac');
INSERT INTO service_types (id, name, description, default_duration, default_price) VALUES
 ('00000000-0000-4000-8000-000000000021', 'Maintenance', 'Routine equipment maintenance', '60', '125'),
 ('00000000-0000-4000-8000-000000000022', 'Inspection', 'On-site inspection', '45', '75');
INSERT INTO jobs (id, identifier, customer_id, technician_id, service_type_id, status, scheduled_time, duration, price, notes) VALUES
 ('00000000-0000-4000-8000-000000000031', 'JOB-1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021', 'scheduled', '09:00', '60', '125', 'Check filters and test the controls.'),
 ('00000000-0000-4000-8000-000000000032', 'JOB-2', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000022', 'in_progress', '11:00', '45', '75', 'Ask reception for access.'),
 ('00000000-0000-4000-8000-000000000033', 'JOB-3', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021', 'scheduled', '14:00', '60', '125', 'Annual maintenance visit.');
UPDATE jobs SET scheduled_date = date('now', '+1 day') WHERE identifier = 'JOB-3';
INSERT INTO job_checklist (id, job_id, label, checked, sort_order) VALUES
 ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000031', 'Inspect filters', '0', '0'),
 ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000031', 'Test controls', '0', '1'),
 ('00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000032', 'Confirm access', '1', '0');
INSERT INTO job_notes (id, job_id, content) VALUES
 ('00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000031', 'Client requested a call on arrival.');
INSERT INTO _meta (key, value) VALUES
 ('job_counter', '3'),
 ('identifier_prefix', 'JOB'),
 ('invoice_counter', '0'),
 ('invoice_prefix', 'INV');
