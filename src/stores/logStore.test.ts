import { describe, expect, test } from "bun:test";
import { LogStore } from "./logStore";
import { JournalLogSource } from "../services/journal";
import { FakeTimers } from "../test-support/fakeTimers";
import type { LogEntry } from "../services/journal";

function entry(seq: number, message = `msg ${seq}`): LogEntry {
  return { ts: 1_757_339_221_000 + seq, seq, level: "info", message };
}

function makeStore(flushMs = 100, cap = 5000): { store: LogStore; journal: JournalLogSource; timers: FakeTimers } {
  const timers = new FakeTimers();
  const journal = new JournalLogSource({ timers });
  const store = new LogStore({ journal, timers, flushMs, cap });
  store.start();
  return { store, journal, timers };
}

describe("LogStore — 100ms trailing-edge flush", () => {
  test("bursts coalesce into ONE flush within the window", () => {
    const { store, timers } = makeStore(100);
    const renders: number[] = [];
    store.subscribe(() => renders.push(store.getSnapshot().entries.length));

    for (let i = 1; i <= 250; i++) store.append(entry(i));
    expect(renders).toEqual([]); // nothing flushed yet
    expect(store.getSnapshot().entries).toEqual([]);

    timers.advance(100);
    expect(renders).toEqual([250]); // single coalesced flush
    expect(store.getSnapshot().entries).toHaveLength(250);
  });

  test("sustained stream flushes at most once per window (trailing edge)", () => {
    const { store, timers } = makeStore(100);
    let flushes = 0;
    store.subscribe(() => flushes++);

    for (let t = 0; t < 1000; t++) {
      store.append(entry(t));
      timers.advance(10); // 100 lines/s equivalent
    }
    // 10s of stream / 100ms flush → ≤ ~100 flushes, not 1000.
    expect(flushes).toBeLessThanOrEqual(101);
    expect(flushes).toBeGreaterThanOrEqual(99);
  });

  test("flush() can be forced immediately", () => {
    const { store } = makeStore(100);
    store.append(entry(1));
    store.flush();
    expect(store.getSnapshot().entries).toHaveLength(1);
  });
});

describe("LogStore — ring bounds + dropped counter", () => {
  test("snapshot never exceeds the ring cap; dropped counts evictions", () => {
    const { store, timers } = makeStore(100, 500);
    for (let i = 1; i <= 1200; i++) store.append(entry(i));
    timers.advance(100);
    const s = store.getSnapshot();
    expect(s.entries).toHaveLength(500);
    expect(s.entries[0]?.seq).toBe(701); // oldest surviving
    expect(s.entries[499]?.seq).toBe(1200); // newest
    expect(s.dropped).toBe(700);
    expect(s.totalAppended).toBe(1200);
  });

  test("journal status events update the snapshot", () => {
    const { journal, store } = makeStore(100);
    // start() already reflected the initial status ("starting").
    expect(store.getSnapshot().journalStatus).toBe("starting");
    // Simulate a status event from the source.
    journal.emit("status", { status: "unavailable", detail: "journalctl not found" });
    const s = store.getSnapshot();
    expect(s.journalStatus).toBe("unavailable");
    expect(s.journalDetail).toBe("journalctl not found");
  });

  test("duplicate seq (journal restart) is ignored", () => {
    const { store, timers } = makeStore(100);
    store.append(entry(5));
    store.append(entry(5)); // restart replay — must be dropped
    store.append(entry(6));
    timers.advance(100);
    const seqs = store.getSnapshot().entries.map((e) => e.seq);
    expect(seqs).toEqual([5, 6]);
  });
});
