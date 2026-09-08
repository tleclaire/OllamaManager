/**
 * Entry point (§8): createCliRenderer with exitOnCtrlC, createRoot + <App/>,
 * runtime built by the composition root. Top-level await is Bun-native.
 */
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createRuntime } from "./runtime";
import { App } from "./ui/App";

const runtime = createRuntime();
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App runtime={runtime} />);
