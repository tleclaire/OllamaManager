import { describe, expect, test } from "bun:test";
import { Emitter } from "./events";

describe("Emitter", () => {
  test("on/emit deliver payloads to registered listeners", () => {
    type Evts = { ping: number; msg: string };
    const e = new Emitter<Evts>();
    const pings: number[] = [];
    const off = e.on("ping", (n) => pings.push(n));
    e.emit("ping", 1);
    e.emit("ping", 2);
    expect(pings).toEqual([1, 2]);
    off();
    e.emit("ping", 3);
    expect(pings).toEqual([1, 2]);
  });

  test("unsubscribe only removes its own listener", () => {
    const e = new Emitter<{ x: void }>();
    const calls: string[] = [];
    const offA = e.on("x", () => calls.push("a"));
    e.on("x", () => calls.push("b"));
    offA();
    e.emit("x", undefined);
    expect(calls).toEqual(["b"]);
  });

  test("contains listener exceptions without breaking other listeners", () => {
    const e = new Emitter<{ x: number }>();
    const calls: number[] = [];
    e.on("x", () => {
      throw new Error("boom");
    });
    e.on("x", (n) => calls.push(n));
    e.emit("x", 7);
    expect(calls).toEqual([7]);
  });

  test("clear() removes everything", () => {
    const e = new Emitter<{ x: number }>();
    let n = 0;
    e.on("x", () => n++);
    e.clear();
    e.emit("x", 1);
    expect(n).toBe(0);
  });
});
