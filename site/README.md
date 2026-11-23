# DeployNow landing page

A static site with no build step: `index.html`, `styles.css`, `main.js` and `assets/`. It is hosted on Cloudflare Pages.

## Cloudflare Pages setup

1. In Cloudflare, go to Workers & Pages → Create → Pages → Connect to Git, and pick `encorp-io/deploynow`.
2. Build settings:
   - Production branch: `main`
   - Framework preset: None
   - Build command: leave empty
   - Build output directory: `site`
3. Save and deploy. Pushes to `main` publish the site, and other branches and pull requests get preview URLs.
4. Optional: under Custom domains, add the domain you want, such as `deploynow.encorp.ai`.
5. Optional: under Settings → Builds → Build watch paths, include only `site/*` so app changes don't trigger a site deploy.

`_headers` sets security headers and caching for `assets/`.

Once the final domain is known, change `og:image` in `index.html` to an absolute URL (for example `https://deploynow.encorp.ai/assets/og.png`), because some social networks ignore relative image URLs.

## Preview locally

```bash
npx serve site    # or: python3 -m http.server -d site
```

## Brand

Brand files in `assets/` are copies from `brand/`. Colours are the tokens at the top of `styles.css`; keep them in sync with `brand/README.md`.

`assets/og.png` is the social preview (1200x630). Regenerate it by screenshotting the page at that size after changing the hero.
