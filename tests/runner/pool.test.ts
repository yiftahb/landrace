import { createSlotPool } from "#runner/pool.js";

/** A person's queue of asks the pool turned away, drained into it whenever a slot comes free. */
function asker(pool: ReturnType<typeof createSlotPool>, person: string) {
  const queue: number[] = [];
  let granted = 0;
  pool.onFree(person, {
    waiting: () => queue.length > 0,
    drain: () => {
      while (queue.length > 0 && pool.take(person)) {
        queue.shift();
        granted += 1;
      }
    },
  });
  return {
    /** One ask now: granted, or queued to wait. */
    ask: (): boolean => {
      if (pool.take(person)) {
        granted += 1;
        return true;
      }
      queue.push(1);
      return false;
    },
    want: (n: number): void => {
      for (let i = 0; i < n; i++) queue.push(1);
    },
    granted: () => granted,
    queued: () => queue.length,
  };
}

describe("the shared slot pool", () => {
  it("splits two slots one each when alice asks for three and bob for one", () => {
    const pool = createSlotPool(2);
    const alice = asker(pool, "alice");
    const bob = asker(pool, "bob");
    // Both are asking before either is granted, as one tick's checks ask.
    alice.want(3);
    bob.want(1);
    for (const person of pool.order(["alice", "bob"])) (person === "alice" ? alice : bob).ask();
    alice.ask();
    alice.ask();

    expect(alice.granted()).toBe(1);
    expect(bob.granted()).toBe(1);
  });

  it("gives a lone asker every slot it has", () => {
    const pool = createSlotPool(2);
    const alice = asker(pool, "alice");
    expect([alice.ask(), alice.ask(), alice.ask()]).toEqual([true, true, false]);
    expect(alice.granted()).toBe(2);
  });

  it("hands the slot alice releases to bob, who was waiting", () => {
    const pool = createSlotPool(2);
    const alice = asker(pool, "alice");
    const bob = asker(pool, "bob");
    alice.ask();
    alice.ask();
    expect(bob.ask()).toBe(false);

    pool.release("alice");

    expect(bob.granted()).toBe(1);
    expect(bob.queued()).toBe(0);
    // Alice holds one of two, and bob the other: her next ask waits.
    expect(alice.ask()).toBe(false);
  });

  it("holds a person to their share while another is asking, and drains them up to the cap once the other stops", () => {
    const pool = createSlotPool(2);
    let bobAsking = true;
    pool.onFree("bob", { waiting: () => bobAsking, drain: () => {} });
    const alice = asker(pool, "alice");
    expect([alice.ask(), alice.ask()]).toEqual([true, false]);

    bobAsking = false;
    pool.nudge();

    expect(alice.granted()).toBe(2);
  });

  it("never holds more than its capacity, and a release of nothing held frees nothing", () => {
    const pool = createSlotPool(1);
    expect(pool.take("alice")).toBe(true);
    pool.release("bob");
    expect(pool.take("bob")).toBe(false);
    pool.release("alice");
    expect(pool.take("bob")).toBe(true);
  });

  it("starts one person further on every call to order", () => {
    const pool = createSlotPool(2);
    expect(pool.order(["bob", "alice", "carol"])).toEqual(["alice", "bob", "carol"]);
    expect(pool.order(["bob", "alice", "carol"])).toEqual(["bob", "carol", "alice"]);
    expect(pool.order(["bob", "alice", "carol"])).toEqual(["carol", "alice", "bob"]);
    expect(pool.order([])).toEqual([]);
  });

  it("drops a listener its function takes off, and a later one replaces an earlier", () => {
    const pool = createSlotPool(1);
    const drained: string[] = [];
    const off = pool.onFree("alice", { waiting: () => false, drain: () => drained.push("first") });
    pool.onFree("alice", { waiting: () => false, drain: () => drained.push("second") });
    off();
    pool.take("alice");
    pool.release("alice");
    expect(drained).toEqual(["second"]);
  });
});
