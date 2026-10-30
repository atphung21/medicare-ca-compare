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
  /** Vitamins, supplements and laxatives: searched on Medicare.gov by name, skipped with a note if not listed. */
  isOtc: z.boolean().optional(),
}).superRefine((drug, context) => {
  if (!drug.isSupply && !drug.isOtc && drug.strength.length === 0) {
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

function retailChain(id: string, name: string, chain = name): PharmacyInput {
  return { id, name, chain, address: NEAREST, isMailOrder: false };
}

const MAIL_ORDER: PharmacyInput = {
  id: "mail-order",
  name: "Plan mail order",
  chain: "Mail Order",
  address: "Home delivery",
  isMailOrder: true,
};

const CHAINS: Record<string, PharmacyInput> = {
  cvs: retailChain("cvs", "CVS Pharmacy", "CVS"),
  walgreens: retailChain("walgreens", "Walgreens"),
  walmart: retailChain("walmart", "Walmart Pharmacy", "Walmart"),
  costco: retailChain("costco", "Costco Pharmacy", "Costco"),
  ralphs: retailChain("ralphs", "Ralphs"),
  vons: retailChain("vons", "Vons"),
  safeway: retailChain("safeway", "Safeway"),
  albertsons: retailChain("albertsons", "Albertsons"),
  heb: retailChain("heb", "H-E-B", "H-E-B"),
  kroger: retailChain("kroger", "Kroger Pharmacy", "Kroger"),
  publix: retailChain("publix", "Publix"),
  "fred-meyer": retailChain("fred-meyer", "Fred Meyer", "Fred Meyer"),
  frys: retailChain("frys", "Fry's", "Fry's"),
  "king-soopers": retailChain("king-soopers", "King Soopers", "King Soopers"),
  "stop-and-shop": retailChain("stop-and-shop", "Stop & Shop", "Stop & Shop"),
  giant: retailChain("giant", "Giant"),
  "jewel-osco": retailChain("jewel-osco", "Jewel-Osco", "Jewel-Osco"),
  meijer: retailChain("meijer", "Meijer"),
  "hy-vee": retailChain("hy-vee", "Hy-Vee", "Hy-Vee"),
  dillons: retailChain("dillons", "Dillons"),
  smiths: retailChain("smiths", "Smith's", "Smith's"),
  hannaford: retailChain("hannaford", "Hannaford"),
  shaws: retailChain("shaws", "Shaw's", "Shaw's"),
  schnucks: retailChain("schnucks", "Schnucks"),
  shoprite: retailChain("shoprite", "ShopRite", "ShopRite"),
  wegmans: retailChain("wegmans", "Wegmans"),
  "harris-teeter": retailChain("harris-teeter", "Harris Teeter", "Harris Teeter"),
  "giant-eagle": retailChain("giant-eagle", "Giant Eagle", "Giant Eagle"),
  weis: retailChain("weis", "Weis"),
  qfc: retailChain("qfc", "QFC"),
  "pick-n-save": retailChain("pick-n-save", "Pick 'n Save", "Pick 'n Save"),
};

/** Shown first wherever those chains are the usual big stores. */
const NATIONAL = ["cvs", "walgreens", "walmart", "costco"];
const NO_COSTCO = new Set(["WV", "WY"]);

/** Extra grocery banners after the national chains. The combined list is capped at eight. */
const STATE_EXTRA: Record<string, string[]> = {
  AL: ["publix"],
  AK: ["fred-meyer"],
  AZ: ["frys", "safeway"],
  AR: ["kroger"],
  CA: ["ralphs", "vons", "safeway", "albertsons"],
  CO: ["king-soopers", "safeway"],
  CT: ["stop-and-shop"],
  DC: ["giant", "safeway"],
  DE: ["giant"],
  FL: ["publix"],
  GA: ["publix", "kroger"],
  HI: ["safeway"],
  ID: ["fred-meyer", "albertsons"],
  IL: ["jewel-osco"],
  IN: ["kroger", "meijer"],
  IA: ["hy-vee"],
  KS: ["dillons", "hy-vee"],
  KY: ["kroger"],
  ME: ["hannaford", "shaws"],
  MD: ["giant", "safeway"],
  MA: ["stop-and-shop", "shaws"],
  MI: ["meijer", "kroger"],
  MN: ["hy-vee"],
  MS: ["kroger"],
  MO: ["schnucks", "hy-vee"],
  MT: ["albertsons"],
  NE: ["hy-vee"],
  NV: ["smiths"],
  NH: ["hannaford"],
  NJ: ["shoprite", "stop-and-shop"],
  NM: ["smiths"],
  NY: ["stop-and-shop", "wegmans"],
  NC: ["publix", "harris-teeter"],
  OH: ["kroger", "meijer", "giant-eagle"],
  OR: ["fred-meyer", "safeway"],
  PA: ["giant", "weis"],
  RI: ["stop-and-shop"],
  SC: ["publix"],
  SD: ["hy-vee"],
  TN: ["kroger", "publix"],
  TX: ["heb", "kroger"],
  UT: ["smiths"],
  VT: ["hannaford"],
  VA: ["kroger", "publix", "harris-teeter"],
  WA: ["fred-meyer", "safeway", "qfc"],
  WV: ["kroger"],
  WI: ["meijer", "pick-n-save"],
  WY: ["albertsons", "smiths"],
};

/** Every chain the assistant can name. The comparison page shows pharmaciesForState instead. */
export const PHARMACY_CATALOG: PharmacyInput[] = [
  ...NATIONAL.map((id) => CHAINS[id]),
  ...Object.values(CHAINS).filter((chain) => !NATIONAL.includes(chain.id)),
  MAIL_ORDER,
];

/** Up to eight big retail pharmacies for a state, then mail order. An unknown state gets the national four. */
export function pharmaciesForState(state: string): PharmacyInput[] {
  const code = state.trim().toUpperCase();
  const known = /^[A-Z]{2}$/.test(code);
  const national = known && NO_COSTCO.has(code) ? NATIONAL.filter((id) => id !== "costco") : NATIONAL;
  const ids = known
    ? [...new Set([...national, ...(STATE_EXTRA[code] ?? [])])].slice(0, 8)
    : [...NATIONAL];
  return [...ids.map((id) => CHAINS[id]), MAIL_ORDER];
}

/** Mail order, plus CVS and Walgreens when that state lists them, otherwise the first two retail names. */
export function defaultPharmacyIds(state: string) {
  const retail = pharmaciesForState(state).filter((pharmacy) => !pharmacy.isMailOrder);
  const named = ["cvs", "walgreens"].filter((id) => retail.some((pharmacy) => pharmacy.id === id));
  const firstTwo = (named.length > 0 ? named : retail.map((pharmacy) => pharmacy.id)).slice(0, 2);
  return [...firstTwo, "mail-order"];
}
