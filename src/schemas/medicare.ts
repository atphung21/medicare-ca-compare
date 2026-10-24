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
  zipCode: z.string().regex(/^9\d{4}$/, "Enter a 5-digit California ZIP code"),
  countyFips: z.string().min(5, "Choose a county"),
  countyName: z.string().min(1),
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

export const CALIFORNIA_COUNTIES = [
  { fips: "06037", name: "Los Angeles" },
  { fips: "06059", name: "Orange" },
  { fips: "06073", name: "San Diego" },
  { fips: "06067", name: "Sacramento" },
  { fips: "06001", name: "Alameda" },
  { fips: "06075", name: "San Francisco" },
  { fips: "06085", name: "Santa Clara" },
  { fips: "06065", name: "Riverside" },
  { fips: "06071", name: "San Bernardino" },
  { fips: "06111", name: "Ventura" },
] as const;

export const ZIP_COUNTY_FIPS: Record<string, string[]> = {
  "91361": ["06111", "06037"],
  "92704": ["06059"],
  "92602": ["06059"],
  "90001": ["06037"],
  "94102": ["06075"],
  "95814": ["06067"],
  "92101": ["06073"],
  "94612": ["06001"],
  "95112": ["06085"],
  "92501": ["06065"],
  "92401": ["06071"],
};

export const PHARMACY_CATALOG: PharmacyInput[] = [
  {
    id: "cvs-bristol",
    name: "CVS Pharmacy",
    chain: "CVS",
    address: "1701 N Bristol St, Santa Ana, CA",
    npi: "1962448571",
    isMailOrder: false,
  },
  {
    id: "walgreens-17th",
    name: "Walgreens",
    chain: "Walgreens",
    address: "1700 E 17th St, Santa Ana, CA",
    npi: "1487654321",
    isMailOrder: false,
  },
  {
    id: "riteaid-main",
    name: "Rite Aid",
    chain: "Rite Aid",
    address: "801 N Main St, Santa Ana, CA",
    npi: "1578901234",
    isMailOrder: false,
  },
  {
    id: "costco-tustin",
    name: "Costco Pharmacy",
    chain: "Costco",
    address: "2700 Park Ave, Tustin, CA",
    npi: "1654321098",
    isMailOrder: false,
  },
  {
    id: "ralphs-harbor",
    name: "Ralphs Pharmacy",
    chain: "Ralphs",
    address: "2000 N Harbor Blvd, Santa Ana, CA",
    npi: "1743201987",
    isMailOrder: false,
  },
  {
    id: "mail-order",
    name: "Plan mail order",
    chain: "Mail Order",
    address: "Home delivery",
    isMailOrder: true,
  },
];

export function countiesForZip(zipCode: string) {
  const fips = ZIP_COUNTY_FIPS[zipCode];
  if (!fips) return [...CALIFORNIA_COUNTIES];
  return CALIFORNIA_COUNTIES.filter((county) => fips.includes(county.fips));
}
