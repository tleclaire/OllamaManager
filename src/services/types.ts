/**
 * Injectable transport seams for services (ARCHITECTURE.md §12).
 * Unit tests never touch real child processes or the network.
 */

/** Minimal process surface OllamaManager actually uses (Bun.spawn-compatible). */
export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with the exit code (0 on clean exit). */
  readonly exited: Promise<number>;
  /** Send a signal to the process (default SIGTERM = 15). */
  kill(signal?: number): void;
}

/** Spawn via argv arrays ONLY — never shell strings (§13 injection safety). */
export type SpawnFn = (argv: string[]) => SpawnedProcess;

export type ReadTextFileFn = (path: string) => Promise<string>;

export type ExecFn = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;

export const defaultSpawn: SpawnFn = (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: (signal?: number) => {
      try {
        proc.kill(signal);
      } catch {
        // Already dead — teardown paths must not throw.
      }
    },
  };
};

/**
 * node:fs readFile (not Bun.file) because /proc files report stat size 0;
 * readFile reads until EOF, which is exactly right for /proc/<pid>/stat.
 */
export const defaultReadTextFile: ReadTextFileFn = (path) => {
  const { readFile } = require("node:fs/promises") as typeof import("node:fs/promises");
  return readFile(path, "utf8") as Promise<string>;
};

export const defaultExec: ExecFn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};
