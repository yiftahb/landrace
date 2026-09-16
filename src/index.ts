/*
 * The package root. Every type in the system is declared in one file, so the
 * root exports that file whole rather than re-listing names: a consumer who
 * can call a value can always name what it takes and what it returns.
 */
export type * from "./namespace.js";
export * from "./core/index.js";
export * from "./conventions.js";
export * from "./hooks/types.js";
