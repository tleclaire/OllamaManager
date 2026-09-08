import { describe, expect, test } from "bun:test";
import { RingBuffer } from "./ringbuffer";

describe("RingBuffer", () => {
  test("starts empty", () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });

  test("pushes and reads back in insertion order", () => {
    const rb = new RingBuffer<number>(5);
    for (const n of [1, 2, 3]) rb.push(n);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
  });

  test("evicts oldest when full (FIFO overwrite)", () => {
    const rb = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) rb.push(n);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.evicted).toBe(2);
  });

  test("capacity 1 keeps only the latest item", () => {
    const rb = new RingBuffer<string>(1);
    rb.push("a");
    rb.push("b");
    expect(rb.toArray()).toEqual(["b"]);
    expect(rb.evicted).toBe(1);
  });

  test("sliceLast returns last n in oldest→newest order", () => {
    const rb = new RingBuffer<number>(10);
    for (let i = 0; i < 7; i++) rb.push(i);
    expect(rb.sliceLast(3)).toEqual([4, 5, 6]);
    expect(rb.sliceLast(100)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rb.sliceLast(0)).toEqual([]);
  });

  test("sliceLast on a wrapped ring is still ordered", () => {
    const rb = new RingBuffer<number>(4);
    for (let i = 0; i < 10; i++) rb.push(i);
    expect(rb.sliceLast(2)).toEqual([8, 9]);
    expect(rb.toArray()).toEqual([6, 7, 8, 9]);
  });

  test("clear resets content and head but keeps capacity", () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.length).toBe(0);
    rb.push(3);
    expect(rb.toArray()).toEqual([3]);
  });

  test("rejects non-positive capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
  });
});
