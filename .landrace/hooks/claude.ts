/*
 * This project's coding agent: Claude Code, as landrace ships it. What it is
 * handed, how it is confined and how a person pairs with it are the
 * integration's (`integrations/claude/`) and the kit's (`src/kit/`); this
 * repository's settings for it are `agent:` in landrace.yaml.
 *
 * `landrace/integrations/claude` resolves here by Node's package
 * self-reference, as `landrace/hooks` does for hooks/github.ts: run
 * `pnpm build` before the CLI runs out of this repository.
 */
import { Claude } from "landrace/integrations/claude";

export const claude = new Claude();
