import type {
  CompareRequest,
  DrugInput,
  DrugPlanBreakdown,
  MedicarePlanComparison,
  NetworkStatus,
  PharmacyInput,
  PharmacyPlanQuote,
} from "@/schemas/medicare";

const PART_D_CAP = 2100;

interface BasePlan {
  contractId: string;
  planId: string;
  segmentId: string;
  planName: string;
  carrierName: string;
  planType: "MAPD" | "PDP";
  starRating: number;
  monthlyPremium: number;
  annualDrugDeductible: number;
}

const BASE_PLANS: BasePlan[] = [
  {
    contractId: "H5425",
    planId: "018",
    segmentId: "000",
    planName: "SCAN Classic (HMO)",
    carrierName: "SCAN Health Plan",
    planType: "MAPD",
    starRating: 4.5,
    monthlyPremium: 0,
    annualDrugDeductible: 0,
  },
  {
    contractId: "H0543",
    planId: "174",
    segmentId: "000",
    planName: "AARP Medicare Advantage from UHC CA-0012 (HMO-POS)",
    carrierName: "UnitedHealthcare",
    planType: "MAPD",
    starRating: 4,
    monthlyPremium: 0,
    annualDrugDeductible: 250,
  },
  {
    contractId: "H3815",
    planId: "009",
    segmentId: "000",
    planName: "Alignment Health Plan smartHMO (HMO)",
    carrierName: "Alignment Health Plan",
    planType: "MAPD",
    starRating: 4,
    monthlyPremium: 0,
    annualDrugDeductible: 0,
  },
  {
    contractId: "S4802",
    planId: "094",
    segmentId: "000",
    planName: "Wellcare Value Script (PDP)",
    carrierName: "Wellcare",
    planType: "PDP",
    starRating: 3.5,
    monthlyPremium: 12.4,
    annualDrugDeductible: 590,
  },
  {
    contractId: "S5601",
    planId: "062",
    segmentId: "000",
    planName: "SilverScript SmartChoice (PDP)",
    carrierName: "Aetna Medicare",
    planType: "PDP",
    starRating: 3.5,
    monthlyPremium: 38.9,
    annualDrugDeductible: 200,
  },
  {
    contractId: "S5884",
    planId: "148",
    segmentId: "000",
    planName: "Humana Value Rx Plan (PDP)",
    carrierName: "Humana",
    planType: "PDP",
    starRating: 3.5,
    monthlyPremium: 46.2,
    annualDrugDeductible: 545,
  },
];

const SUBSTITUTABLE = ["lipitor", "crestor", "nexium", "flomax"];
const BRANDS = [
  "eliquis",
  "lipitor",
  "lantus",
  "jardiance",
  "ozempic",
  "xarelto",
  "symbicort",
  "humira",
  "crestor",
];

function networkFor(carrierName: string, pharmacy: PharmacyInput): NetworkStatus {
  const chain = pharmacy.chain.toUpperCase();
  if (pharmacy.isMailOrder) return "PREFERRED";
  if (carrierName.includes("Aetna") && chain.includes("CVS")) return "PREFERRED";
  if (carrierName.includes("SCAN") && (chain.includes("CVS") || chain.includes("COSTCO"))) {
    return "PREFERRED";
  }
  if (carrierName.includes("Wellcare") && (chain.includes("CVS") || chain.includes("WALGREENS"))) {
    return "PREFERRED";
  }
  if (carrierName.includes("UnitedHealthcare") && chain.includes("WALGREENS")) return "PREFERRED";
  if (carrierName.includes("Humana") && chain.includes("WALGREENS")) return "PREFERRED";
  if (carrierName.includes("Alignment") && chain.includes("RITE AID")) return "OUT_OF_NETWORK";
  return "STANDARD";
}

function drugProfile(drug: DrugInput, carrierName: string) {
  const name = drug.name.toLowerCase();
  const isBrand = BRANDS.some((brand) => name.includes(brand));
  const canSubstitute = isBrand && drug.acceptGeneric && SUBSTITUTABLE.some((brand) => name.includes(brand));
  const specialty = name.includes("humira") || name.includes("ozempic");
  const complex = drug.dosageForm === "INHALER" || drug.dosageForm === "INJECTABLE_PEN" || drug.dosageForm === "VIAL";

  let tier = 1;
  let retailMonth = 14 + Math.min(drug.quantityPerFill, 90) * 0.15;
  if (complex && !canSubstitute) {
    tier = specialty ? 5 : 4;
    retailMonth = specialty ? 1400 : drug.dosageForm === "INHALER" ? 360 : 280;
  } else if (isBrand && !canSubstitute) {
    tier = 3;
    retailMonth = 310;
  } else if (canSubstitute) {
    tier = 2;
    retailMonth = 22;
  }

  const months = drug.refillFrequencyMonths === "3" ? 3 : 1;
  const fillsPerYear = 12 / months;
  const mailFactor = months === 3 ? 2.45 : 1;
  const retailPerFill = round(retailMonth * mailFactor);

  const uncovered =
    (carrierName.includes("Humana") && tier === 5) ||
    (carrierName.includes("Alignment") && drug.dosageForm === "INHALER");

  return {
    tier,
    retailPerFill,
    fillsPerYear,
    covered: !uncovered,
    usedGeneric: canSubstitute,
    priorAuth: tier >= 4,
    stepTherapy: isBrand && !canSubstitute && tier === 3,
    quantityLimit: drug.quantityPerFill > 60 ? `${drug.quantityPerFill} per fill` : null,
    deductibleApplies: tier >= 3,
  };
}

function shareFor(tier: number, retail: number, network: NetworkStatus) {
  if (network === "OUT_OF_NETWORK") return retail;
  const preferred = network === "PREFERRED";
  if (tier === 1) return preferred ? 0 : 5;
  if (tier === 2) return preferred ? 8 : 16;
  if (tier === 3) return retail * (preferred ? 0.24 : 0.35);
  if (tier === 4) return retail * (preferred ? 0.33 : 0.45);
  return retail * (preferred ? 0.25 : 0.33);
}

function quotePharmacy(
  plan: BasePlan,
  pharmacy: PharmacyInput,
  medications: DrugInput[],
): PharmacyPlanQuote {
  const networkStatus = networkFor(plan.carrierName, pharmacy);
  let deductibleLeft = plan.annualDrugDeductible;
  let annualDrug = 0;
  const drugBreakdowns: DrugPlanBreakdown[] = medications.map((drug) => {
    const profile = drugProfile(drug, plan.carrierName);
    if (!profile.covered || networkStatus === "OUT_OF_NETWORK") {
      const uncoveredAnnual = profile.covered ? round(profile.retailPerFill * profile.fillsPerYear) : 0;
      annualDrug += uncoveredAnnual;
      return {
        drugId: drug.id,
        drugName: drug.name,
        coveredOnFormulary: profile.covered && networkStatus !== "OUT_OF_NETWORK",
        tier: profile.covered ? profile.tier : null,
        deductibleApplies: profile.deductibleApplies,
        negotiatedRetailMonthlyCost: round(profile.retailPerFill / (drug.refillFrequencyMonths === "3" ? 3 : 1)),
        initialCoverageMonthlyCopay: profile.covered ? round(uncoveredAnnual / 12) : 0,
        annualOutOfPocketForDrug: uncoveredAnnual,
        priorAuth: profile.priorAuth,
        stepTherapy: profile.stepTherapy,
        quantityLimit: profile.quantityLimit,
        usedGeneric: profile.usedGeneric,
      };
    }

    const memberPerFill = Math.min(profile.retailPerFill, shareFor(profile.tier, profile.retailPerFill, networkStatus));
    let paid = 0;
    for (let fill = 0; fill < profile.fillsPerYear; fill += 1) {
      const room = PART_D_CAP - (annualDrug + paid);
      if (room <= 0) break;
      let thisFill = memberPerFill;
      if (profile.deductibleApplies && deductibleLeft > 0) {
        const toward = Math.min(deductibleLeft, profile.retailPerFill);
        deductibleLeft -= toward;
        thisFill = Math.max(thisFill, toward);
        thisFill = Math.min(thisFill, profile.retailPerFill);
      }
      paid += Math.min(thisFill, room);
    }
    paid = round(paid);
    annualDrug += paid;
    const months = drug.refillFrequencyMonths === "3" ? 3 : 1;
    return {
      drugId: drug.id,
      drugName: drug.name,
      coveredOnFormulary: true,
      tier: profile.tier,
      deductibleApplies: profile.deductibleApplies,
      negotiatedRetailMonthlyCost: round(profile.retailPerFill / months),
      initialCoverageMonthlyCopay: round(memberPerFill / months),
      annualOutOfPocketForDrug: paid,
      priorAuth: profile.priorAuth,
      stepTherapy: profile.stepTherapy,
      quantityLimit: profile.quantityLimit,
      usedGeneric: profile.usedGeneric,
    };
  });

  annualDrug = round(Math.min(annualDrug, PART_D_CAP));
  const premiumAnnual = round(plan.monthlyPremium * 12);
  const hitsCap = annualDrug >= PART_D_CAP;
  return {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    networkStatus,
    annualDrugCostOop: annualDrug,
    totalAnnualCost: round(premiumAnnual + annualDrug),
    hitsCatastrophicCap: hitsCap,
    monthCatastrophicReached: hitsCap ? "Before year end" : null,
    drugBreakdowns,
  };
}

export function compareCaliforniaPlans(payload: CompareRequest): MedicarePlanComparison[] {
  const retailCount = payload.pharmacies.filter((pharmacy) => !pharmacy.isMailOrder).length;
  if (retailCount > 5) {
    throw new Error("Select at most five retail pharmacies.");
  }
  return BASE_PLANS.map((plan) => ({
    ...plan,
    sample: true as const,
    pharmacyQuotes: payload.pharmacies.map((pharmacy) => quotePharmacy(plan, pharmacy, payload.medications)),
  }));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
