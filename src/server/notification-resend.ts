import { ProviderError, sanitizeErrorMessage, statusToErrorCode } from "./notification-providers.js";
import type { EmailProvider, EmailSendInput, ProviderSendResult } from "./notification-providers.js";

/**
 * Resend adapter — send only. No retry logic here (the dispatcher owns
 * retry/backoff); this function's only job is "make one real API call, map
 * the result, sanitize any error." See https://resend.com/docs/api-reference/emails/send-email
 * for the contract this implements.
 */
export function createResendEmailProvider(apiKey: string, fromAddress: string): EmailProvider {
  return {
    async send(input: EmailSendInput): Promise<ProviderSendResult> {
      let res: Response;
      try {
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            // Phase 9.4 — best-effort duplicate-send mitigation for the
            // "provider accepted, Worker died before recording it" window.
            // See EmailSendInput.idempotencyKey's doc comment for the exact
            // confidence level this carries.
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
          }),
        });
      } catch {
        // Network-level failure (DNS, connection reset) — never leak the
        // underlying fetch error's message, which can include request URLs.
        throw new ProviderError("provider_network_error", "Failed to reach Resend");
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new ProviderError(statusToErrorCode(res.status), sanitizeErrorMessage(bodyText) || `Resend responded ${res.status}`);
      }

      const data = await res.json().catch(() => null) as { id?: string } | null;
      if (!data?.id) {
        throw new ProviderError("provider_invalid_response", "Resend response missing message id");
      }
      return { providerMessageId: data.id };
    },
  };
}
