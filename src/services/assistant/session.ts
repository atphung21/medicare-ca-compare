import type { CheckedMedication } from "@/lib/draft-cards";
import type { CountyChoice } from "@/lib/us-location";
import type { LisLevel, PlanCategory } from "@/schemas/medicare";

/** Everything the assistant is working on. The browser keeps it and sends it with each message, so the server stays stateless. */
export interface AssistantSession {
  zipCode: string | null;
  county: CountyChoice | null;
  contractYear: "2026" | "2027";
  lisLevel: LisLevel;
  planType: PlanCategory;
  pharmacyIds: string[];
  medications: CheckedMedication[];
}

export const EMPTY_SESSION: AssistantSession = {
  zipCode: null,
  county: null,
  contractYear: "2027",
  lisLevel: "LIS_NONE",
  planType: "ALL",
  pharmacyIds: ["cvs", "walgreens"],
  medications: [],
};

export interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  ok: boolean;
  /** Medicare.gov proof screenshots, served by /api/medicare/proof/[id]/[file]. */
  images?: { label: string; src: string }[];
  link?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  events?: ToolEvent[];
}
