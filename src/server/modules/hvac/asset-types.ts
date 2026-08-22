/**
 * Phase 11.4 — pure asset-type label data for the HVAC industry module. No
 * business logic lives here (mirrors modules/programs/bc/workflow-
 * definitions.ts's own "pure data, no logic" shape). src/server/index.ts
 * (a composition root, allowed to import every module) composes this into
 * the full ASSET_TYPE_REGISTRY used for request validation and the
 * GET /api/assets/types listing endpoint — src/server/assets.ts (Core) never
 * imports this file or knows these keys exist, exactly per Phase 11.1's
 * "Core must not depend on Industry module internals" rule.
 *
 * Only types with an actual current business need are listed here — no
 * speculative HVAC equipment categories.
 */

export const HVAC_ASSET_TYPES: Record<string, { label: string }> = {
  HEAT_PUMP: { label: "Heat Pump" },
  FURNACE: { label: "Furnace" },
  BOILER: { label: "Boiler" },
  AIR_CONDITIONER: { label: "Air Conditioner" },
  WATER_HEATER: { label: "Water Heater" },
  THERMOSTAT: { label: "Thermostat" },
  AIR_HANDLER: { label: "Air Handler" },
};
