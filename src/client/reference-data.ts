import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { GlobalSetting } from "./types";

/** Referral-source and heating-source dropdown options, sourced from Global
 *  Settings (category=reference_data) rather than hardcoded in each form — see
 *  migrations/0004_rebate_eligibility.sql for the seeded defaults. Admins can
 *  change the option lists at any time via the Global Settings page without a
 *  code change or touching every component that renders one of these dropdowns. */
export function useReferenceData() {
  const [referralSources, setReferralSources] = useState<string[]>([]);
  const [heatingSources, setHeatingSources] = useState<string[]>([]);
  // Phase 8.4 — Lead lost-reason catalog (LEAD_LOST_REASON_OPTIONS, seeded
  // by migration 0010). Sourced from the same existing reference-data
  // endpoint, never hardcoded here — see src/server/lead-workflow.ts, which
  // is the actual validation authority; this is display-only.
  const [leadLostReasons, setLeadLostReasons] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ settings: GlobalSetting[] }>("GET", "/api/settings?category=reference_data");
        if (cancelled) return;
        const referral = res.settings.find((s) => s.key === "REFERRAL_SOURCE_OPTIONS");
        const heating = res.settings.find((s) => s.key === "HEATING_SOURCE_OPTIONS");
        const leadLost = res.settings.find((s) => s.key === "LEAD_LOST_REASON_OPTIONS");
        if (referral) setReferralSources(JSON.parse(referral.value));
        if (heating) setHeatingSources(JSON.parse(heating.value));
        if (leadLost) setLeadLostReasons(JSON.parse(leadLost.value));
      } catch {
        // Reference data is a UX nicety, not a hard dependency — leave the
        // dropdowns empty (free-text fallback) rather than blocking the form.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { referralSources, heatingSources, leadLostReasons };
}
