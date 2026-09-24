import { generateCss } from "#ui/generate-css.js";
import { APP_CSS } from "#ui/styles.generated.js";

/**
 * The whole reason `styles.generated.ts` is committed rather than built on
 * every boot: raw Node, the hook loader and jest all read it with no build
 * step. That only stays true if it actually is what `pnpm css` would produce
 * right now — so this regenerates it in memory and compares. A class added
 * to page.ts without re-running `pnpm css` changes what Tailwind's scanner
 * finds in that file and fails this test, rather than shipping a page that
 * silently renders unstyled.
 */
describe("the generated CSS", () => {
  it("is exactly what `pnpm css` would produce right now", async () => {
    const fresh = await generateCss();
    expect(fresh).toBe(APP_CSS);
  }, 30_000);
});
