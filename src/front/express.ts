import * as loaded from "express";
import type { ExpressModule } from "#namespace.js";

/**
 * Express, however this module was compiled. Express is CommonJS
 * (`export =`): imported from an ES module, the function is the namespace's
 * `default`; required from CommonJS — the test pass, which compiles without
 * the interop helper that would copy every namespace it imports — it is the
 * namespace itself.
 */
export const express: ExpressModule = ((loaded as unknown as { default?: ExpressModule }).default ?? loaded) as unknown as ExpressModule;
