/**
 * useStore(store, selector) — thin useSyncExternalStore wrapper (§4.8).
 *
 * IMPORTANT: the selector must return a STABLE reference between snapshots
 * (a field of the snapshot, or a slice object/array that the store re-creates
 * only on real changes). Never build fresh objects/arrays inside the selector.
 */
import { useSyncExternalStore } from "react";
import type { StoreBase } from "../stores/base";

export interface StoreLike<S> {
  subscribe(cb: () => void): () => void;
  getSnapshot(): S;
}

export function useStore<S extends object, T>(store: StoreLike<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

export type { StoreBase };
