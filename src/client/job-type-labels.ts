import type { JobType } from "./types";

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  STANDARD: "Standard",
  CLEANBC: "CleanBC Rebate",
  BC_HYDRO: "BC Hydro Rebate",
};

export const JOB_TYPE_OPTIONS: JobType[] = ["STANDARD", "CLEANBC", "BC_HYDRO"];
