// Post-build script: generates dist/ui.html from the bundle.
// The running open-krode server reads this file on every GET /,
// so a `bun run build` + browser refresh is enough to see UI changes
// without restarting OpenCode.

import { getHtmlBundle } from "../src/ui/bundle";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const html = getHtmlBundle();
const out = join(import.meta.dir, "../dist/ui.html");
writeFileSync(out, html, "utf-8");
console.log(`wrote ${out} (${html.length} bytes)`);
