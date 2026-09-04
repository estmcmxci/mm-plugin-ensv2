# Site

Docs and explainer for `@estmcmxci/mm-plugin-ensv2`, built with [Vocs](https://vocs.dev) 2 as a fully static site. Deployed to a subdomain of estmcmxci.co on Cloudflare Pages; the root domain is a separate site.

```sh
npm install
npm run generate     # regenerate reference pages from ../oclif.manifest.json, ../src, ../dist (run `npm run build` in the plugin root first)
npm run dev          # http://localhost:5173
npm run build        # dist/ — plain HTML, plus /llms.txt and /llms-full.txt
npm run preview
```

`SITE_URL` sets the canonical base URL at build time (default `https://mm-ensv2.estmcmxci.co`); Cloudflare's `CF_PAGES_URL` is used for previews.

Static files in `public/` are served from `/`: the marks, and the ERC-8004 registration files at `/agents/<agentId>.json`.

Palette and type follow estmcmxci.co (IBM Plex Sans, grayscale tokens) via `src/pages/_root.css`; everything else is Vocs.
