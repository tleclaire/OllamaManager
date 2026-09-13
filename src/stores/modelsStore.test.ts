import { describe, expect, test } from "bun:test";
import { ModelsStore, type OllamaApiLike } from "./modelsStore";
import type { ModelDetails, OllamaModel, RunningModel } from "../services/ollamaApi";

function sampleModel(name: string, size = 1_000_000): OllamaModel {
  return {
    name,
    model: name,
    size,
    digest: "d".repeat(64),
    modified_at: "2026-09-08T00:00:00Z",
    details: { family: "qwen3", families: ["qwen3"], parameter_size: "9.2B", quantization_level: "Q4_K_M" },
  };
}

function sampleRunning(name: string): RunningModel {
  return { name, model: name, size: 1, size_vram: 1, expires_at: "2026-09-08T16:30:00Z" };
}

/** Scripted fake API: each call shifts the next scripted behavior. */
type ListModelsStep = () => OllamaModel[] | Promise<OllamaModel[]>;

function fakeApi(script: {
  listModels?: ListModelsStep[];
  listRunning?: RunningModel[][];
  showModel?: (name: string) => Promise<ModelDetails>;
}): OllamaApiLike & { calls: string[] } {
  const calls: string[] = [];
  let tagsIdx = 0;
  let psIdx = 0;
  const listModelsSteps: ListModelsStep[] = script.listModels ?? [[] as unknown as OllamaModel[]].map(() => () => []);
  const listRunningSets: RunningModel[][] = script.listRunning ?? [[]];
  return {
    calls,
    async listModels() {
      calls.push("listModels");
      const behavior = listModelsSteps[Math.min(tagsIdx, listModelsSteps.length - 1)] as ListModelsStep;
      tagsIdx++;
      return behavior();
    },
    async listRunning() {
      calls.push("listRunning");
      const models = listRunningSets[Math.min(psIdx, listRunningSets.length - 1)] as RunningModel[];
      psIdx++;
      return models;
    },
    showModel: async (name) => {
      calls.push(`showModel:${name}`);
      return script.showModel
        ? script.showModel(name)
        : { modelfile: "# mf", parameters: "stop <|im_end|>", template: "{{ .Prompt }}", details: sampleModel(name).details };
    },
    deleteModel: async (name) => {
      calls.push(`delete:${name}`);
    },
    copyModel: async (source, destination) => {
      calls.push(`copy:${source}>${destination}`);
    },
    unload: async (model) => {
      calls.push(`unload:${model}`);
    },
  };
}

describe("ModelsStore — refresh + apiStatus", () => {
  test("successful refresh sets ok + tags + lastRefresh", async () => {
    const api = fakeApi({ listModels: [() => [sampleModel("a"), sampleModel("b")]], listRunning: [[sampleRunning("a")]] });
    const store = new ModelsStore({ api });
    await store.refreshTags();
    await store.refreshRunning();
    const s = store.getSnapshot();
    expect(s.tags.map((m) => m.name)).toEqual(["a", "b"]);
    expect(s.running).toHaveLength(1);
    expect(s.apiStatus).toBe("ok");
    expect(s.lastRefresh).toBeGreaterThan(0);
  });

  test("initial status is checking, failure flips to down with detail", async () => {
    const api = fakeApi({
      listModels: [
        () => {
          throw new Error("connect ECONNREFUSED");
        },
      ],
    });
    const store = new ModelsStore({ api });
    expect(store.getSnapshot().apiStatus).toBe("checking");
    await store.refreshTags();
    const s = store.getSnapshot();
    expect(s.apiStatus).toBe("down");
    expect(s.lastError).toContain("ECONNREFUSED");
    // Last-known list stays visible (§11).
    expect(s.tags).toEqual([]);
  });

  test("recovers to ok on the next successful poll", async () => {
    const api = fakeApi({
      listModels: [
        () => {
          throw new Error("down");
        },
        () => [sampleModel("recovered")],
      ],
    });
    const store = new ModelsStore({ api });
    await store.refreshTags();
    expect(store.getSnapshot().apiStatus).toBe("down");
    await store.refreshTags();
    expect(store.getSnapshot().apiStatus).toBe("ok");
    expect(store.getSnapshot().tags[0]?.name).toBe("recovered");
  });
});

describe("ModelsStore — selection + details", () => {
  test("select stores the selected name", () => {
    const store = new ModelsStore({ api: fakeApi({}) });
    store.select("m1");
    expect(store.getSnapshot().selected).toBe("m1");
    store.select(null);
    expect(store.getSnapshot().selected).toBeNull();
  });

  test("loadDetails stores details and clears loading", async () => {
    const store = new ModelsStore({ api: fakeApi({}) });
    const promise = store.loadDetails("m1");
    expect(store.getSnapshot().detailsLoading).toBe(true);
    await promise;
    const s = store.getSnapshot();
    expect(s.details?.modelfile).toBe("# mf");
    expect(s.detailsModel).toBe("m1");
    expect(s.detailsLoading).toBe(false);
  });

  test("stale details response is discarded when user switched models", async () => {
    const holder: { resolveA?: (d: ModelDetails) => void } = {};
    const api = fakeApi({
      showModel: (name) =>
        new Promise<ModelDetails>((resolve) => {
          if (name === "a") holder.resolveA = resolve;
          else resolve({ modelfile: name, parameters: "", template: "", details: sampleModel(name).details });
        }),
    });
    const store = new ModelsStore({ api });
    const p1 = store.loadDetails("a");
    const p2 = store.loadDetails("b");
    holder.resolveA?.({ modelfile: "STALE", parameters: "", template: "", details: sampleModel("a").details });
    await Promise.all([p1, p2]);
    expect(store.getSnapshot().details?.modelfile).toBe("b"); // not STALE
  });
});

describe("ModelsStore — mutating actions refresh tags", () => {
  test("remove calls delete then refreshes tags", async () => {
    const api = fakeApi({ listModels: [() => [sampleModel("x")], () => []] });
    const store = new ModelsStore({ api });
    await store.refreshTags(); // initial inventory (also done by start())
    await store.remove("x");
    expect(api.calls).toContain("delete:x");
    expect(api.calls.filter((c) => c === "listModels").length).toBeGreaterThanOrEqual(2);
    expect(store.getSnapshot().tags).toEqual([]);
  });

  test("copy and unload call the API and refresh", async () => {
    const api = fakeApi({ listModels: [() => [sampleModel("a")]] });
    const store = new ModelsStore({ api });
    await store.copy("a", "b");
    await store.unload("a");
    expect(api.calls).toContain("copy:a>b");
    expect(api.calls).toContain("unload:a");
    expect(store.getSnapshot().apiStatus).toBe("ok");
  });

  test("failed mutation records lastError but does not crash", async () => {
    const api = fakeApi({
      listModels: [() => [sampleModel("a")]],
    });
    api.deleteModel = async () => {
      throw new Error("model is running");
    };
    const store = new ModelsStore({ api });
    await store.remove("a");
    expect(store.getSnapshot().lastError).toContain("failed to delete");
  });
});

describe("ModelsStore — deterministic model order (ollama#12866)", () => {
  const model = (name: string, modifiedAt: string): OllamaModel => ({ ...sampleModel(name), modified_at: modifiedAt });

  test("newest first, regardless of the order the API returns", async () => {
    const api = fakeApi({
      listModels: [() => [model("old", "2026-09-13T15:24:25.290190466+02:00"), model("new", "2026-09-13T15:47:27.466124179+02:00")]],
    });
    const store = new ModelsStore({ api });
    await store.refreshTags();
    expect(store.getSnapshot().tags.map((m) => m.name)).toEqual(["new", "old"]);
  });

  test("identical timestamps fall back to a name tiebreak", async () => {
    const ts = "2026-09-13T15:47:27.412105065+02:00";
    const api = fakeApi({
      listModels: [
        () => [model("qwen3.5-9b-64k", ts), model("gemma4-12b-32k", ts), model("bge-large", ts)],
      ],
    });
    const store = new ModelsStore({ api });
    await store.refreshTags();
    expect(store.getSnapshot().tags.map((m) => m.name)).toEqual(["bge-large", "gemma4-12b-32k", "qwen3.5-9b-64k"]);
  });

  test("every rotation of Ollama's unstable cycle yields the same list", async () => {
    // The exact fixed cycle measured from a live /api/tags, all sharing one second.
    const cycle = ["qwen3.5-9b-64k", "Qwen3.8-27B-8k", "qwen2.5-coder:14b-8k", "gemma4-12b-32k", "qwen2.5-coder-7b-32k", "bge-large"];
    const rotations = cycle.map((_, i) => [...cycle.slice(i), ...cycle.slice(0, i)]);
    const api = fakeApi({ listModels: rotations.map((r) => () => r.map((n) => model(n, "2026-09-13T15:47:27.4+02:00"))) });
    const store = new ModelsStore({ api });
    const results: string[][] = [];
    for (let i = 0; i < rotations.length; i++) {
      await store.refreshTags();
      results.push(store.getSnapshot().tags.map((m) => m.name));
    }
    const canonical = results[0] ?? [];
    for (const r of results) expect(r).toEqual(canonical);
    expect(canonical).toEqual([...cycle].sort()); // name ascending
  });

  test("an unparsable modified_at is treated as oldest, not a crash", async () => {
    const api = fakeApi({ listModels: [() => [model("broken", "not-a-date"), model("valid", "2026-09-13T15:47:27.4+02:00")]] });
    const store = new ModelsStore({ api });
    await store.refreshTags();
    expect(store.getSnapshot().tags.map((m) => m.name)).toEqual(["valid", "broken"]);
  });
});
