# DeployNow landing page

Static site, no build step: `index.html`, `styles.css`, `main.js` and `assets/`.
The workflow `.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push to `main` that touches `site/`.

Preview locally:

```bash
npx serve site    # or: python3 -m http.server -d site
```

Brand files in `assets/` are copies from `brand/`. Colours are the tokens at the top of `styles.css`; keep them in sync with `brand/README.md`.

`assets/og.png` is the social preview (1200x630). Regenerate it by screenshotting the page at that size after changing the hero.

For a custom domain such as `deploynow.encorp.ai`, add a `CNAME` file here with the domain and set it under Settings, Pages.
