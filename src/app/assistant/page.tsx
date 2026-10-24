import { AssistantChat } from "@/components/assistant-chat";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Medicare assistant",
};

export default function AssistantPage() {
  return <AssistantChat />;
}
