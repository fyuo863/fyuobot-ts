#!/usr/bin/env node

/**
 * fyuobot CLI entry point
 *
 * Uses the project's local tsx to run the TypeScript source directly,
 * so source changes are reflected immediately without recompilation.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tsxPath = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entryPath = join(root, "src", "tui", "index.tsx");

const child = spawn(process.execPath, [tsxPath, entryPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
});

child.on("close", (code) => {
    process.exit(code ?? 0);
});
