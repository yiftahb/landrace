/**
 * What a hook author imports. Published as `landrace/hooks`, so a hook module
 * in someone's `.landrace/` gets the define* helpers, the types they take, and
 * the shared vocabulary — label names and the marker format — from one place.
 *
 * The loader is deliberately not here: importing hooks is the engine's job,
 * and a hook that loaded hooks would be a cycle waiting to happen.
 */
export * from "#hooks/contracts.js";
export * from "#conventions.js";

/*
 * Named one by one rather than `export type *`: every type in the system is
 * declared in one file, and only some of them are a hook author's business.
 * A hook that could name `ConvergeDeps` is a hook the engine's shape has
 * leaked into. This list is exactly what `landrace/hooks` published before
 * the types moved out of the modules beside it.
 */
export type {
  ArtifactHook,
  Closed,
  Effect,
  Entry,
  Executor,
  ExecutorContext,
  ExecutorFactory,
  Graph,
  Handoff,
  HandoffArg,
  HookContext,
  HookKind,
  Json,
  Marker,
  NewTicket,
  Node,
  Operator,
  Origin,
  PostHook,
  PreHook,
  Preflight,
  RelationDecl,
  Relationship,
  RuntimeContext,
  Snapshot,
  Source,
  TicketPatch,
  TrackerComment,
} from "#namespace.js";
