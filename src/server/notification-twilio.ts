import { ProviderError, sanitizeErrorMessage, statusToErrorCode } from "./notification-providers.js";
import type { ProviderSendResult, SmsProvider, SmsSendInput } from "./notification-providers.js";

/**
 * Twilio adapter — send only, same contract as the Resend adapter. No
 * consent/retry logic here — the dispatcher already re-checked consent
 * before this is ever called. See
 * https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
 * for the contract this implements.
 */
export function createTwilioSmsProvider(accountSid: string, authToken: string, fromNumber: string): SmsProvider {
  return {
    async send(input: SmsSendInput): Promise<ProviderSendResult> {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
      const body = new URLSearchParams({ To: input.to, From: fromNumber, Body: input.body });

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
      } catch {
        throw new ProviderError("provider_network_error", "Failed to reach Twilio");
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new ProviderError(statusToErrorCode(res.status), sanitizeErrorMessage(bodyText) || `Twilio responded ${res.status}`);
      }

      const data = await res.json().catch(() => null) as { sid?: string } | null;
      if (!data?.sid) {
        throw new ProviderError("provider_invalid_response", "Twilio response missing message SID");
      }
      return { providerMessageId: data.sid };
    },
  };
}
