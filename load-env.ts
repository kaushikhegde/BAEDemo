// Read `.env` before any other module of the consumer config is evaluated.
//
// A module of its own, imported FIRST by `orchestrator.config.ts`, because ESM
// evaluates every import before the importing module's body. This loop used to
// sit in that body — after `orchestrator.workflows.ts` had already been
// evaluated and had read PUBLISH_TARGET at load time. So `PUBLISH_TARGET=none`
// in `.env` was silently ignored and the workflows compiled with publish steps.
//
// Here rather than inside packages/orchestrator, because loading a config file
// is the CONSUMER's job — the library is handed a resolved config object and
// must not go hunting for one (see CLAUDE.md).
//
// `process.loadEnvFile` is built into Node — no dotenv dependency. It does NOT
// overwrite a variable that is already set, so an explicit
// `DATABASE_URL=… npm run serve` still beats the file.
//
// `.env.local` is loaded second for per-machine overrides. Neither file is
// required; a deployment configured purely through real environment variables
// simply has neither.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const installRoot = process.env.SCYNE_INSTALL_ROOT ?? process.cwd();

for (const file of [".env", ".env.local"]) {
  const path = resolve(installRoot, file);
  if (existsSync(path)) process.loadEnvFile(path);
}
