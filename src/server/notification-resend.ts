import { ProviderError, sanitizeErrorMessage, statusToErrorCode } from "./notification-providers.js";
import type { EmailProvider, EmailSendInput, ProviderSendResult } from "./notification-providers.js";

/** `String.fromCharCode(...bytes)` blows the call stack on anything larger
 *  than a few tens of KB (V8's argument-spread limit) — a multi-page
 *  signed Contract PDF attachment is comfortably past that, so this
 *  chunks the conversion instead of spreading the whole array at once. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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
            // Resend expects base64-encoded content per attachment — see
            // https://resend.com/docs/api-reference/emails/send-email.
            ...(input.attachments && input.attachments.length > 0 ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content: bytesToBase64(a.content),
              })),
            } : {}),
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
