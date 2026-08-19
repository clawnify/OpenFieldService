import { get, query } from "./db.js";

/**
 * Phase 9.3 — read-only notification history, scoped per domain entity
 * (Customer/Lead/Job/Invoice) rather than one generic
 * `GET /api/notifications?entity_type=...` route — this codebase's
 * existing sub-resource convention is exclusively domain-specific
 * (`/api/leads/{id}/status-history`, `/api/invoices/{id}/audit`), and a
 * generic query endpoint would also be a slightly-too-close cousin of the
 * "arbitrary messaging endpoint" this phase's own spec forbids. Never
 * selects `payload` (Section 18: no raw payload dump) — only the fields
 * the UI actually needs, matching the minimal-fields discipline already
 * established for `notification_outbox` at enqueue time.
 */

export interface NotificationHistoryRow {
  id: number;
  event_type: string;
  channel: string;
  recipient: string;
  status: string;
  attempts: number;
  last_error: string;
  scheduled_for: string;
  sent_at: string | null;
  created_at: string;
}

export interface DeliveryAttemptRow {
  notification_id: number;
  attempt_number: number;
  status: string;
  provider_message_id: string | null;
  error_code: string;
  error_message: string;
  attempted_at: string;
  completed_at: string | null;
}

const HISTORY_COLUMNS = "id, event_type, channel, recipient, status, attempts, last_error, scheduled_for, sent_at, created_at";

export interface HistoryPage {
  notifications: NotificationHistoryRow[];
  attempts: DeliveryAttemptRow[];
  total: number;
}

async function attemptsFor(notificationIds: number[]): Promise<DeliveryAttemptRow[]> {
  if (notificationIds.length === 0) return [];
  const placeholders = notificationIds.map(() => "?").join(",");
  return query<DeliveryAttemptRow>(
    `SELECT notification_id, attempt_number, status, provider_message_id, error_code, error_message, attempted_at, completed_at
     FROM notification_delivery_attempts WHERE notification_id IN (${placeholders}) ORDER BY notification_id, attempt_number`,
    notificationIds
  );
}

/** Every Job/Invoice/Payment belonging to a Customer — a Customer has no
 *  own row in `notification_outbox` (only the entities it owns do), so
 *  "this Customer's notification history" means resolving backward through
 *  those owned entities. `payments` has no `customer_id` of its own —
 *  reached via its owning invoice, same join shape `resolveRecipientCustomerId()`
 *  (notification-dispatcher.ts) already uses in the opposite direction. */
export async function getCustomerNotificationHistory(customerId: number, limit: number, offset: number): Promise<HistoryPage> {
  const where = `
    (entity_type = 'job' AND entity_id IN (SELECT id FROM jobs WHERE customer_id = ?))
    OR (entity_type = 'invoice' AND entity_id IN (SELECT id FROM invoices WHERE customer_id = ?))
    OR (entity_type = 'payment' AND entity_id IN (SELECT id FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ?)))
  `;
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM notification_outbox WHERE ${where}`, [customerId, customerId, customerId]);
  const notifications = await query<NotificationHistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM notification_outbox WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [customerId, customerId, customerId, limit, offset]
  );
  const attempts = await attemptsFor(notifications.map((n) => n.id));
  return { notifications, attempts, total: countRow?.count || 0 };
}

/** Leads have no wired notification events yet (Phase 9.1/9.2 explicitly
 *  out of scope — see mem:phase9/notifications-architecture-audit) — this
 *  will correctly return an empty page today, and needs no change when a
 *  future phase wires Lead events, since it already queries by the real
 *  entity_type/entity_id shape those events would use. */
export async function getLeadNotificationHistory(leadId: number, limit: number, offset: number): Promise<HistoryPage> {
  const where = "entity_type = 'lead' AND entity_id = ?";
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM notification_outbox WHERE ${where}`, [leadId]);
  const notifications = await query<NotificationHistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM notification_outbox WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [leadId, limit, offset]
  );
  const attempts = await attemptsFor(notifications.map((n) => n.id));
  return { notifications, attempts, total: countRow?.count || 0 };
}

export async function getJobNotificationHistory(jobId: number, limit: number, offset: number): Promise<HistoryPage> {
  const where = "entity_type = 'job' AND entity_id = ?";
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM notification_outbox WHERE ${where}`, [jobId]);
  const notifications = await query<NotificationHistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM notification_outbox WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [jobId, limit, offset]
  );
  const attempts = await attemptsFor(notifications.map((n) => n.id));
  return { notifications, attempts, total: countRow?.count || 0 };
}

/** Invoice history covers both `invoice.issued` (entity_type='invoice')
 *  AND `payment.received` (entity_type='payment', scoped through this
 *  invoice's own payments) — a payment is its own entity (see
 *  notifications.ts's enqueuePaymentReceived() doc comment) but belongs to
 *  exactly one invoice, so both are shown together on the one page that
 *  actually represents this financial thread to staff. */
export async function getInvoiceNotificationHistory(invoiceId: number, limit: number, offset: number): Promise<HistoryPage> {
  const where = "(entity_type = 'invoice' AND entity_id = ?) OR (entity_type = 'payment' AND entity_id IN (SELECT id FROM payments WHERE invoice_id = ?))";
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM notification_outbox WHERE ${where}`, [invoiceId, invoiceId]);
  const notifications = await query<NotificationHistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM notification_outbox WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [invoiceId, invoiceId, limit, offset]
  );
  const attempts = await attemptsFor(notifications.map((n) => n.id));
  return { notifications, attempts, total: countRow?.count || 0 };
}
