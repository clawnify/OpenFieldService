import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { AssetType, GlobalSetting } from "./types";

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
  // Phase 11.4 — Asset/Equipment types. Unlike the 3 lists above (Global
  // Settings option lists), this is sourced from GET /api/assets/types —
  // the same server-side ASSET_TYPE_REGISTRY (Core + HVAC module
  // contributions) used to validate asset_type on create/update, so the
  // dropdown can never drift out of sync with what the server accepts.
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ types: AssetType[] }>("GET", "/api/assets/types");
        if (!cancelled) setAssetTypes(res.types);
      } catch {
        // Same graceful-degradation policy as the Global-Settings-backed
        // lists above.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { referralSources, heatingSources, leadLostReasons, assetTypes };
}
