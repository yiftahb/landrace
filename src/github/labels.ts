/** The label vocabulary the shipped workflow uses. */
export const LABELS = {
  eligible: "lr:auto",
  working: "lr:working",
  awaiting: "lr:awaiting",
  blocked: "lr:blocked",
  approved: "lr:approved",
  stage: (id: string) => `lr:stage:${id}`,
} as const;

const STAGE_RE = /^lr:stage:(.+)$/;

/** Position is a label, so two of them means we cannot place the ticket. */
export function stageFromLabels(labels: string[]): { stage: string | null; ambiguous: boolean } {
  const found = labels.map((l) => STAGE_RE.exec(l)?.[1]).filter((s): s is string => Boolean(s));
  return { stage: found[0] ?? null, ambiguous: found.length > 1 };
}
