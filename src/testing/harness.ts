import { markOf } from "#agent/screen.js";
import { converge } from "#runner/converge.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import type {
  Dispatcher,
  Harness,
  HarnessOptions,
  HarnessRun,
  HookContext,
  Logger,
  PostHook,
  StepCall,
} from "#namespace.js";
import { scriptedExecutor } from "#testing/scripted.js";

/**
 * An item, driven through a workflow, with what happened written down.
 *
 * Everything here was copied between test files before it was a function: a
 * logger that remembers which stage is running so the executor can answer as
 * it, a position trail stitched out of the evaluation events, and a count of
 * what each step was paid for. None of that is specific to a workflow or to a
 * tracker, which is why it ships rather than living in one repository's tests.
 *
 * What it deliberately does not own is the world. The hooks come in from
 * outside — the in-memory tracker beside this file, or a real integration over
 * a fake HTTP boundary — because a harness that supplied its own tracker would
 * only ever prove that a workflow works against that harness.
 */
export function createHarness(options: HarnessOptions): Harness {
  const item = options.item ?? "1";
  const calls: StepCall[] = [];
  const trail: string[] = [];
  let at = { stage: "", round: 1 };

  const push = (stage: unknown): void => {
    if (typeof stage === "string" && stage !== trail.at(-1)) trail.push(stage);
  };

  const base = options.log ?? createLogger({ sink: () => {} });
  const log: Logger = (name, data = {}) => {
    // step.started as well as step.invoked: the screener is asked before the
    // step is invoked, and it answers as the stage about to run, not as the
    // last one that did.
    if (name === "step.started" || name === "step.invoked") {
      at = { stage: String(data.stage), round: Number(data.round) };
    }
    if (name === "item.evaluated") {
      // Where it was, then where it went. The destination is what makes the
      // last transition of a run visible at all: nothing evaluates an item
      // from the stage it finished in.
      push(data.stage);
      push(data.to);
    }
    base(name, data);
  };

  const scripted = scriptedExecutor(options.answers ?? {}, () => at);
  // Its own script, never the step's: a screener that answered with the
  // step's text would read as unparseable and refuse everything.
  const scriptedScreen = options.screen === undefined ? undefined : scriptedExecutor(options.screen, () => at);
  // A script cannot know the nonce a screening is marked with — it is new on
  // every call — so each verdict it writes is given it, unless it names one.
  const screener = scriptedScreen && {
    id: scriptedScreen.id,
    run: async (prompt: string, opts: Parameters<typeof scriptedScreen.run>[1]) => {
      const answer = await scriptedScreen.run(prompt, opts);
      if (answer.text.includes('"nonce"')) return answer;
      return { ...answer, text: answer.text.replace(/"verdict"\s*:/g, `"nonce": "${markOf(prompt) ?? ""}", "verdict":`) };
    },
  };
  const executor = {
    id: "harness",
    run: async (prompt: string, opts: { round: number; signal: AbortSignal }) => {
      calls.push({ ...at, prompt });
      // The two things that happen outside the engine while a step runs: a
      // push, and a person. Before the answer, because that is when they
      // happen — the pull request exists by the time the build says it is done.
      await options.during?.(at);
      return scripted.run(prompt, opts);
    },
  };

  /** A post hook that dies at a chosen effect, to cut an effect list in half mid-flight. */
  const breaking = (inner: PostHook, applied: () => number): PostHook => ({
    id: inner.id,
    handles: inner.handles,
    creates: inner.creates,
    satisfied: (s, e) => inner.satisfied(s, e),
    apply: async (effect, ctx) => {
      if (options.interrupt?.(effect, applied())) throw new Error("the process died here");
      return inner.apply(effect, ctx);
    },
  });

  const dispatcherFor = (): Dispatcher => {
    if (!options.interrupt) return createDispatcher(options.post);
    // Counted per call, not per harness: "the process died after three
    // effects" is a fact about one run of the loop, and a second call after a
    // crash is the resumption, not a continuation of the same count.
    let applied = 0;
    return createDispatcher(options.post.map((hook) => breaking(hook, () => ++applied)));
  };

  return {
    calls: () => [...calls],
    trail: () => [...trail],
    counts: () =>
      calls.reduce<{ [stage: string]: number }>((acc, call) => ({ ...acc, [call.stage]: (acc[call.stage] ?? 0) + 1 }), {}),

    converge: async (): Promise<HarnessRun> => {
      const from = { calls: calls.length, trail: trail.length };
      const result = await converge(item, {
        workflow: options.workflow,
        steps: options.steps,
        source: options.source,
        pre: options.pre,
        ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
        dispatcher: dispatcherFor(),
        executor,
        ...(screener === undefined ? {} : { screen: { executor: screener, model: "screener" } }),
        ctx: {
          item,
          config: {} as HookContext["config"],
          secrets: new Map<string, string>(),
          signal: new AbortController().signal,
          log: () => {},
        },
        log,
        ...(options.maxPasses === undefined ? {} : { maxPasses: options.maxPasses }),
        ...(options.notify === undefined ? {} : { notify: options.notify }),
        ...(options.startedAt === undefined ? {} : { startedAt: async (branch: string) => options.startedAt?.(branch) ?? null }),
      }).catch((e: unknown) => {
        // A converge that throws is a defect in a hook, not a workflow
        // outcome, and it has to read as one rather than as a rejected
        // promise three awaits away from the test that caused it.
        throw new Error(`converge threw rather than reporting: ${String(e)}`);
      });

      return { result, calls: calls.slice(from.calls), trail: trail.slice(from.trail) };
    },
  };
}
