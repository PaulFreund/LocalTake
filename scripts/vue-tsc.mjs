// vue-tsc needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("vue-tsc").run(require.resolve("@typescript/typescript6/lib/tsc"));
