import type { LisLevel } from "@/schemas/medicare";

export interface LisCopaySchedule {
  year: "2026" | "2027";
  level: LisLevel;
  genericCopay: number;
  brandCopay: number;
  deductible: number;
  partDCap: number;
  label: string;
}

const PROGRAMS: Record<Exclude<LisLevel, "LIS_NONE">, string> = {
  LIS_MEDICAID: "Medicaid",
  LIS_SSI: "Supplemental Security Income",
  LIS_MSP: "Medicare Savings Program",
  LIS_SS: "Extra Help (with drug costs)",
};

type SubsidyBand = "LOW" | "HIGH";

const SCHEDULES: Record<"2026" | "2027", Record<SubsidyBand, Omit<LisCopaySchedule, "year" | "level" | "label"> & { detail: string }>> = {
  "2026": {
    LOW: {
      genericCopay: 1.6,
      brandCopay: 4.9,
      deductible: 0,
      partDCap: 2100,
      detail: "2026 lower full Extra Help copay, up to $1.60 generic and $4.90 brand per fill, $0 deductible.",
    },
    HIGH: {
      genericCopay: 5.1,
      brandCopay: 12.65,
      deductible: 0,
      partDCap: 2100,
      detail: "2026 higher full Extra Help copay, up to $5.10 generic and $12.65 brand per fill, $0 deductible.",
    },
  },
  "2027": {
    LOW: {
      genericCopay: 1.65,
      brandCopay: 5,
      deductible: 0,
      partDCap: 2400,
      detail: "2027 lower full Extra Help copay, up to $1.65 generic and $5.00 brand per fill, $0 deductible.",
    },
    HIGH: {
      genericCopay: 5.8,
      brandCopay: 14.4,
      deductible: 0,
      partDCap: 2400,
      detail: "2027 higher full Extra Help copay, up to $5.80 generic and $14.40 brand per fill, $0 deductible.",
    },
  },
};

function subsidyBand(level: LisLevel): SubsidyBand | null {
  if (level === "LIS_MEDICAID" || level === "LIS_SSI") return "LOW";
  if (level === "LIS_MSP" || level === "LIS_SS") return "HIGH";
  return null;
}

export function partDCap(year: "2026" | "2027") {
  return year === "2027" ? 2400 : 2100;
}

export function lisSchedule(year: "2026" | "2027", level: LisLevel): LisCopaySchedule | null {
  const band = subsidyBand(level);
  if (!band || level === "LIS_NONE") return null;
  const schedule = SCHEDULES[year][band];
  return { year, level, ...schedule, label: `${PROGRAMS[level]}: ${schedule.detail}` };
}
