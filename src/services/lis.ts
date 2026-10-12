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

const SCHEDULES: Record<"2026" | "2027", Record<Exclude<LisLevel, "NONE">, Omit<LisCopaySchedule, "year" | "level">>> = {
  "2026": {
    FULL: {
      genericCopay: 1.6,
      brandCopay: 4.9,
      deductible: 0,
      partDCap: 2100,
      label:
        "2026 CMS full-benefit dual eligible at or below 100% of the poverty level: up to $1.60 generic and $4.90 brand per fill, $0 deductible.",
    },
    PARTIAL: {
      genericCopay: 5.1,
      brandCopay: 12.65,
      deductible: 0,
      partDCap: 2100,
      label:
        "Partial Extra Help was folded into full Extra Help. This uses the 2026 higher statutory full-subsidy copay: up to $5.10 generic and $12.65 brand per fill, $0 deductible.",
    },
  },
  "2027": {
    FULL: {
      genericCopay: 1.65,
      brandCopay: 5,
      deductible: 0,
      partDCap: 2400,
      label:
        "2027 CMS full-benefit dual eligible at or below 100% of the poverty level: up to $1.65 generic and $5.00 brand per fill, $0 deductible.",
    },
    PARTIAL: {
      genericCopay: 5.8,
      brandCopay: 14.4,
      deductible: 0,
      partDCap: 2400,
      label:
        "Partial Extra Help was folded into full Extra Help. This uses the 2027 higher statutory full-subsidy copay: up to $5.80 generic and $14.40 brand per fill, $0 deductible.",
    },
  },
};

export function partDCap(year: "2026" | "2027") {
  return year === "2027" ? 2400 : 2100;
}

export function lisSchedule(year: "2026" | "2027", level: LisLevel): LisCopaySchedule | null {
  if (level === "NONE") return null;
  return { year, level, ...SCHEDULES[year][level] };
}
