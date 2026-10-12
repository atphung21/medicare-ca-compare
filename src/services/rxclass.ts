const RXNAV = "https://rxnav.nlm.nih.gov/REST/rxclass";

export interface TherapeuticAlternative {
  rxcui: string;
  name: string;
  className: string;
}

export async function therapeuticAlternatives(rxcui: string): Promise<TherapeuticAlternative[]> {
  const classesResponse = await fetch(`${RXNAV}/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}`, {
    next: { revalidate: 86400 },
  });
  if (!classesResponse.ok) return [];
  const classesBody = await classesResponse.json();
  const classes = classesBody?.rxclassDrugInfoList?.rxclassDrugInfo ?? [];
  const preferred =
    classes.find((item: { rxclassMinConceptItem?: { classType?: string } }) => item.rxclassMinConceptItem?.classType === "ATC1-4") ??
    classes.find((item: { relaSource?: string }) => item.relaSource === "ATC") ??
    classes[0];
  const concept = preferred?.rxclassMinConceptItem;
  if (!concept?.classId) return [];

  const relaSource = preferred.relaSource ?? "ATC";
  const membersUrl = `${RXNAV}/classMembers.json?classId=${encodeURIComponent(concept.classId)}&relaSource=${encodeURIComponent(relaSource)}${preferred.rela ? `&rela=${encodeURIComponent(preferred.rela)}` : ""}`;
  const membersResponse = await fetch(membersUrl, { next: { revalidate: 86400 } });
  if (!membersResponse.ok) return [];
  const membersBody = await membersResponse.json();
  const members = membersBody?.drugMemberGroup?.drugMember ?? [];
  const seen = new Set<string>();
  const alternatives: TherapeuticAlternative[] = [];
  for (const member of members) {
    const min = member.minConcept;
    const id = String(min?.rxcui ?? "");
    const name = String(min?.name ?? "");
    const tty = String(min?.tty ?? "");
    if (!id || id === rxcui || !name || seen.has(name.toLowerCase())) continue;
    if (tty && !["IN", "SCD", "SBD", "BN"].includes(tty)) continue;
    seen.add(name.toLowerCase());
    alternatives.push({ rxcui: id, name, className: concept.className ?? "Same class" });
    if (alternatives.length >= 8) break;
  }
  return alternatives;
}
