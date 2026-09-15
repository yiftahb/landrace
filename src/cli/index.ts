// Placeholder CLI entry point.
// package.json's "bin" and tsup.config.ts's "cli" build entry both reference
// this file already, ahead of the CLI implementation that a later task adds.
// This stub exists only so `pnpm build` produces a working (no-op) dist/cli.js
// in the meantime; it contains no logic of its own.
export {};
