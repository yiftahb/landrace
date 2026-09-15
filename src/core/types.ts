/** Anything a hook can put in the snapshot. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * The tracker-agnostic record of something the workflow has written or a human
 * has said. A tracker hook decides how these are stored — GitHub uses trailing
 * markers in comments — and core never learns that format.
 */
export interface Entry {
  stage: string;
  /** "output" for a step result, "human" for a person, otherwise hook-defined. */
  kind: string;
  round: number;
  data?: unknown;
  /** ISO 8601. Ordering is by this field, not array position. */
  at: string;
  /** True when we wrote it. False means a person did. */
  byAgent: boolean;
}

/** Open by design: hooks contribute whatever they contribute. */
export interface Snapshot {
  [key: string]: unknown;
  entries?: Entry[];
  now?: number;
  run?: Run;
}

export interface Run {
  stage: string | null;
  /** Distinct output rounds per stage. Derived, never stored. */
  counters: { [stage: string]: number };
  outputs: { [stage: string]: unknown };
  lastEvent: { actor: "agent" | "human" | null; at: string | null };
  lastHuman: Entry | null;
  /** Never true: a step is either invalid (false) or has no verdict (null), never affirmatively "valid". */
  lastOutputValid: false | null;
  /** Every stage with a rejected round, independent of which stage `lastOutputValid` answers for. */
  failedStages: string[];
  unblockedAt: number;
}

/** A MongoDB-style condition document over snapshot dot-paths. */
export type Condition = { [path: string]: unknown };

export interface Trigger {
  name?: string;
  when: Condition;
}

export interface Effect {
  type: string;
  [key: string]: unknown;
}

export interface Stage {
  id: string;
  step?: string;
  entry?: boolean;
  terminal?: boolean;
  identity?: Condition;
  requires?: Condition;
  triggers?: Trigger[];
  on_enter?: Effect[];
}

export interface EligibilityRule {
  when: Condition;
  else: string;
}

export interface Workflow {
  version: number;
  name: string;
  stages: Stage[];
  eligible?: EligibilityRule[];
  budget?: { [key: string]: unknown };
  hooks?: { pre?: string[]; post?: string[] };
  artifacts?: { [name: string]: { hook: string; ref: string } };
}

export type SubState = "pending" | "complete" | "failed";

export interface Decision {
  action: "invoke" | "wait" | "transition" | "halt" | "skip";
  stage?: Stage;
  subState?: SubState;
  to?: Stage;
  step?: string;
  round?: number;
  trigger?: string;
  why?: string;
}
