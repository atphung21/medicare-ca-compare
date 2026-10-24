import { z } from "zod";

export const PlanCategorySchema = z.enum(["ALL", "MAPD", "PDP", "MEDIGAP"]);
export type PlanCategory = z.infer<typeof PlanCategorySchema>;

export const DosageFormSchema = z.enum([
  "TABLET",
  "CAPSULE",
  "INJECTABLE_PEN",
  "VIAL",
  "INHALER",
  "CREAM",
  "DROPS",
  "SUPPLY",
]);
export type DosageForm = z.infer<typeof DosageFormSchema>;

export const ResolutionStatusSchema = z.enum([
  "UNRESOLVED",
  "AUTO_LOCKED",
  "AMBIGUOUS_FORM",
  "NOT_FOUND",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const ResolvedVariantSchema = z.object({
  rxcui: z.string().min(1),
  fullName: z.string().min(1),
  strength: z.string().min(1),
  dosageForm: z.string().min(1),
  coarseForm: DosageFormSchema,
  isExtendedRelease: z.boolean(),
  isBrand: z.boolean(),
});
export type ResolvedVariant = z.infer<typeof ResolvedVariantSchema>;

export const DrugInputSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(2, "Drug name is required"),
  strength: z.string().trim(),
  dosageForm: DosageFormSchema,
  dosageFormLabel: z.string().optional(),
  quantityPerFill: z.number().int().min(1, "Quantity is required"),
  refillFrequencyMonths: z.enum(["1", "3"]),
  acceptGeneric: z.boolean(),
  rxcui: z.string().optional(),
  resolvedName: z.string().optional(),
  ndc: z.string().optional(),
  resolutionStatus: ResolutionStatusSchema.optional(),
  isBrand: z.boolean().optional(),
  compareBothForms: z.boolean().optional(),
  alternate: ResolvedVariantSchema.optional(),
  /** Diabetic supplies such as test strips have no strength and are searched on Medicare.gov by name. */
  isSupply: z.boolean().optional(),
}).superRefine((drug, context) => {
  if (!drug.isSupply && drug.strength.length === 0) {
    context.addIssue({ code: "custom", path: ["strength"], message: "Strength is required, for example 20mg" });
  }
});

export const PharmacyInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  chain: z.string(),
  address: z.string(),
  npi: z.string().optional(),
  isMailOrder: z.boolean(),
});

export const LisLevelSchema = z.enum(["LIS_NONE", "LIS_MEDICAID", "LIS_SSI", "LIS_MSP", "LIS_SS"]);
export type LisLevel = z.infer<typeof LisLevelSchema>;

export const CompareRequestSchema = z.object({
  zipCode: z.string().regex(/^\d{5}$/, "Enter a 5-digit ZIP code"),
  countyFips: z.string().min(5, "Choose a county"),
  countyName: z.string().min(1),
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
  contractYear: z.enum(["2026", "2027"]),
  lisLevel: LisLevelSchema.default("LIS_NONE"),
  medications: z.array(DrugInputSchema).min(1, "Add at least one medication"),
  pharmacies: z
    .array(PharmacyInputSchema)
    .min(1, "Select at least one pharmacy")
    .max(6, "Select at most five retail pharmacies plus mail order"),
});

export type DrugInput = z.infer<typeof DrugInputSchema>;
export type PharmacyInput = z.infer<typeof PharmacyInputSchema>;
export type CompareRequest = z.infer<typeof CompareRequestSchema>;

export interface DrugPlanBreakdown {
  drugId: string;
  drugName: string;
  rxcui: string | null;
  dosageFormLabel: string | null;
  coveredOnFormulary: boolean;
  tier: number | null;
  deductibleApplies: boolean;
  negotiatedRetailMonthlyCost: number;
  initialCoverageMonthlyCopay: number;
  annualOutOfPocketForDrug: number;
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: string | null;
  usedGeneric: boolean;
}

export type NetworkStatus = "PREFERRED" | "STANDARD" | "OUT_OF_NETWORK";

export interface PharmacyPlanQuote {
  pharmacyId: string;
  pharmacyName: string;
  networkStatus: NetworkStatus;
  annualDrugCostOop: number;
  januaryDrugCost: number;
  mpppMonthlyEstimate: number;
  totalAnnualCost: number;
  hitsCatastrophicCap: boolean;
  monthCatastrophicReached: string | null;
  drugBreakdowns: DrugPlanBreakdown[];
}

export interface MedicarePlanComparison {
  contractId: string;
  planId: string;
  segmentId: string;
  planName: string;
  carrierName: string;
  planType: "MAPD" | "PDP";
  starRating: number;
  monthlyPremium: number;
  annualDrugDeductible: number;
  premiumNote: string | null;
  pharmacyQuotes: PharmacyPlanQuote[];
  sample: true;
}

export function coarseDosageForm(label: string): DosageForm {
  const text = label.toLowerCase();
  if (/\bsupply\b/.test(text)) return "SUPPLY";
  if (/\bpen\b|auto-?injector|prefilled/.test(text)) return "INJECTABLE_PEN";
  if (text.includes("inhal") || text.includes("diskus") || text.includes("ellipta") || text.includes("respimat") || text.includes("hfa")) {
    return "INHALER";
  }
  if (text.includes("cream") || text.includes("ointment") || text.includes("gel")) return "CREAM";
  if (text.includes("drop") || text.includes("ophthalmic") || text.includes("otic")) return "DROPS";
  if (text.includes("capsule")) return "CAPSULE";
  if (text.includes("vial") || text.includes("injection") || text.includes("injectable")) return "VIAL";
  return "TABLET";
}

const NEAREST = "Nearest store to the ZIP code";

/** National chains. The Medicare.gov proof picks the closest store of each chain to the ZIP code. */
export const PHARMACY_CATALOG: PharmacyInput[] = [
  { id: "cvs", name: "CVS Pharmacy", chain: "CVS", address: NEAREST, isMailOrder: false },
  { id: "walgreens", name: "Walgreens", chain: "Walgreens", address: NEAREST, isMailOrder: false },
  { id: "walmart", name: "Walmart Pharmacy", chain: "Walmart", address: NEAREST, isMailOrder: false },
  { id: "costco", name: "Costco Pharmacy", chain: "Costco", address: NEAREST, isMailOrder: false },
  { id: "kroger", name: "Kroger Pharmacy", chain: "Kroger", address: NEAREST, isMailOrder: false },
  {
    id: "mail-order",
    name: "Plan mail order",
    chain: "Mail Order",
    address: "Home delivery",
    isMailOrder: true,
  },
];
