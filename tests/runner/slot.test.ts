import { createRuntimeSlot } from "#runner/slot.js";

describe("createRuntimeSlot", () => {
  it("holds nothing until the first reload, then what each build answered, null included", async () => {
    const answers: Array<{ n: number } | null> = [{ n: 1 }, null, { n: 2 }];
    const slot = createRuntimeSlot(async () => answers.shift() ?? null);
    expect(slot.current()).toBeNull();
    await slot.reload();
    expect(slot.current()).toEqual({ n: 1 });
    await slot.reload();
    expect(slot.current()).toBeNull();
    await slot.reload();
    expect(slot.current()).toEqual({ n: 2 });
  });

  it("keeps the previous runtime when a build throws, and the error propagates", async () => {
    let fail = false;
    const first = { n: 1 };
    const slot = createRuntimeSlot(async () => {
      if (fail) throw new Error("hooks would not load");
      return first;
    });
    await slot.reload();
    fail = true;
    await expect(slot.reload()).rejects.toThrow("hooks would not load");
    expect(slot.current()).toBe(first);
  });

  it("hands each swapped-out runtime to onSwap, once, and nothing for a failed build", async () => {
    const swapped: unknown[] = [];
    let n = 0;
    const slot = createRuntimeSlot(async () => {
      n += 1;
      if (n === 3) throw new Error("no");
      return { n };
    }, { onSwap: (old) => { swapped.push(old); } });
    await slot.reload();
    await slot.reload();
    await expect(slot.reload()).rejects.toThrow("no");
    expect(swapped).toEqual([null, { n: 1 }]);
  });

  /*
   * Two connects at once: each reload builds after the one before it has
   * swapped, so the later connect's build is the one left standing, never a
   * slow first build landing over it.
   */
  it("runs one build at a time, in the order reloads were asked", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    let n = 0;
    const slot = createRuntimeSlot(async () => {
      n += 1;
      const mine = n;
      order.push(`start ${mine}`);
      if (mine === 1) await new Promise<void>((r) => gates.push(r));
      order.push(`end ${mine}`);
      return { n: mine };
    });
    const a = slot.reload();
    const b = slot.reload();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start 1"]);
    gates[0]?.();
    await Promise.all([a, b]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(slot.current()).toEqual({ n: 2 });
  });

  it("goes on reloading after a build that threw", async () => {
    let fail = true;
    const slot = createRuntimeSlot(async () => {
      if (fail) throw new Error("no");
      return { n: 1 };
    });
    await expect(slot.reload()).rejects.toThrow("no");
    fail = false;
    await slot.reload();
    expect(slot.current()).toEqual({ n: 1 });
  });
});
