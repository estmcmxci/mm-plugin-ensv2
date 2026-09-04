// After `vocs build` (full-static): Vocs writes each page's Markdown twin under
// assets/md/<route>.md but only rewrites /<route>.md → that file when a server is
// running. On Cloudflare Pages a `_redirects` file with 200 rewrites restores the
// convention documented on the "For agents" page, so /install.md and /index.md work.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "dist", "public");
const mdRoot = join(pub, "assets", "md");
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : f.endsWith(".md") && files.push(relative(mdRoot, p)); } })(mdRoot);
const lines = files.sort().map((f) => `/${f}  /assets/md/${f}  200`);
writeFileSync(join(pub, "_redirects"), lines.join("\n") + "\n");
console.log(`_redirects: ${lines.length} markdown rewrites`);
