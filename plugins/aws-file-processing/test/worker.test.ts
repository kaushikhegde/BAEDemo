import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withRenewedVisibility, runResilientTurn, sweepTempDir } from "../src/worker/index.js";

describe("withRenewedVisibility", () => {
  it("waits for a renewal still in flight before handing back the pop receipt", async () => {
    // Deterministic, not timing-dependent: `updateMessage` and `work` only
    // resolve when THIS test says so, so the exact race window the fix
    // closes — a renewal's response still on the wire the instant `work`
    // finishes — is constructed on purpose rather than hoped for.
    let updateCalls = 0;
    let resolveRenewal!: (v: { popReceipt: string }) => void;
    const renewal = new Promise<{ popReceipt: string }>((r) => { resolveRenewal = r; });
    const q = {
      updateMessage: async () => { updateCalls++; return renewal; },
    } as any;

    let resolveWork!: () => void;
    const workGate = new Promise<void>((r) => { resolveWork = r; });

    const call = withRenewedVisibility(
      q, { messageId: "m1", popReceipt: "original" }, 300, 5, // 5ms heartbeat
      async () => { await workGate; return "done"; },
    );

    // Wait for the real 5ms heartbeat to actually fire at least once (it
    // calls the fake `updateMessage`, which is now blocked on `renewal` —
    // a renewal genuinely in flight).
    while (updateCalls === 0) await new Promise((r) => setTimeout(r, 1));

    // Let `work` finish NOW, while that renewal is still unresolved.
    resolveWork();

    // The renewal is still in flight; only once we resolve it here does
    // withRenewedVisibility's wait complete.
    resolveRenewal({ popReceipt: "rotated" });

    const { result, popReceipt } = await call;
    expect(result).toBe("done");
    expect(updateCalls).toBeGreaterThan(0);
    expect(popReceipt).toBe("rotated"); // not "original" — the in-flight renewal was awaited
  });

  it("returns the original pop receipt untouched when the heartbeat never fires", async () => {
    const q = { updateMessage: async () => ({ popReceipt: "should-not-be-used" }) } as any;
    const { result, popReceipt } = await withRenewedVisibility(
      q, { messageId: "m1", popReceipt: "original" }, 300, 120_000, // heartbeat far longer than work
      async () => "quick",
    );
    expect(result).toBe("quick");
    expect(popReceipt).toBe("original");
  });

  it("propagates work's rejection after cleanly awaiting any in-flight renewal", async () => {
    let resolveRenewal!: (v: { popReceipt: string }) => void;
    const renewal = new Promise<{ popReceipt: string }>((r) => { resolveRenewal = r; });
    let updateCalls = 0;
    const q = { updateMessage: async () => { updateCalls++; return renewal; } } as any;

    // work() is gated on a signal the test controls, not an immediate throw
    // — an immediate throw would settle before the heartbeat's first tick
    // ever fires, since real timers need actual wall-clock time to pass,
    // leaving updateCalls at 0 forever and hanging the poll loop below.
    let rejectWork!: (e: Error) => void;
    const workGate = new Promise<never>((_, reject) => { rejectWork = reject; });

    const call = withRenewedVisibility(
      q, { messageId: "m1", popReceipt: "original" }, 300, 5,
      () => workGate,
    );
    while (updateCalls === 0) await new Promise((r) => setTimeout(r, 1));
    rejectWork(new Error("work failed"));
    resolveRenewal({ popReceipt: "rotated" });

    await expect(call).rejects.toThrow("work failed");
  });
});

describe("the pre-fix pattern, for comparison", () => {
  it("a bare clearInterval with no await reads the stale receipt in the same race", async () => {
    // This is what runOnce did before the fix: stop future ticks, then read
    // popReceipt synchronously with nothing awaited in between. Reproduced
    // here (not by calling into src/) to show concretely what the fix
    // prevents, using the exact same controlled race as the test above.
    let updateCalls = 0;
    let resolveRenewal!: (v: { popReceipt: string }) => void;
    const renewal = new Promise<{ popReceipt: string }>((r) => { resolveRenewal = r; });
    const updateMessage = async () => { updateCalls++; return renewal; };

    let popReceipt = "original";
    const heartbeat = setInterval(() => {
      void updateMessage().then((r) => { popReceipt = r.popReceipt; });
    }, 5);

    while (updateCalls === 0) await new Promise((r) => setTimeout(r, 1));

    // "work" finishes now, exactly as it would in runOnce right after
    // process1() resolves.
    clearInterval(heartbeat); // the entire old fix: stop future ticks, nothing else
    expect(popReceipt).toBe("original"); // STALE — the in-flight renewal has not landed

    resolveRenewal({ popReceipt: "rotated" }); // let the dangling promise settle
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("runResilientTurn", () => {
  it("does not throw when a turn fails, and backs off before returning", async () => {
    const fakeStorage = {
      queue: () => ({
        receiveMessages: async () => { throw new Error("simulated transient network blip"); },
      }),
    } as any;
    const started = Date.now();
    const result = await runResilientTurn(
      { cfg: { maxDequeueCount: 3 } as any, storage: fakeStorage },
      { errorBackoffMs: 25 },
    );
    expect(result).toBe("error");
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("leaves the fast idle path fast — no error backoff on an empty queue", async () => {
    const fakeStorage = {
      queue: () => ({ receiveMessages: async () => ({ receivedMessageItems: [] }) }),
    } as any;
    // errorBackoffMs is absurdly large: if runResilientTurn mistakenly took
    // the error path for an ordinary idle turn, this test would time out.
    const result = await runResilientTurn(
      { cfg: { maxDequeueCount: 3 } as any, storage: fakeStorage },
      { idleDelayMs: 5, errorBackoffMs: 999_999 },
    );
    expect(result).toBe("idle");
  });
});

describe("sweepTempDir (I2)", () => {
  it("removes every entry directly under tempDir, files and directories alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-sweep-"));
    writeFileSync(join(dir, "a-leaked-scratch.jsonl"), "leftover from a killed job");
    writeFileSync(join(dir, "b-leaked.docx"), "leftover");
    mkdirSync(join(dir, "some-subdir"));
    writeFileSync(join(dir, "some-subdir", "c.tmp"), "nested leftover");

    const removed = await sweepTempDir(dir);

    expect(removed).toBe(3); // three top-level entries, one of them a directory
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not throw when tempDir does not exist — a first boot has nothing to sweep", async () => {
    const missing = join(tmpdir(), `afp-sweep-missing-${randomUUID()}`);
    await expect(sweepTempDir(missing)).resolves.toBe(0);
  });
});
