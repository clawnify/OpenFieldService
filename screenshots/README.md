# README cover sources and micro UI previews

Keep only the screenshots needed to generate the README covers:
[light schedule](schedule.png) and [dark schedule](schedule-dark.png).
The four conceptual micro UI previews live in [../previews/](../previews/)
and are recreated in HTML/CSS/SVG, grounded in the app code and running app.

Cover sources were captured with TaskWindow on 15 September 2026 using a
separate local database and fictional customers, at 1440×960.

## What controls the output

- [manifest.json](manifest.json): screenshot routes, dimensions, themes,
  captions, cover selection, feature source-code paths, illustration metadata and carousel order.
- [../previews/](../previews/): four 1600×1000 conceptual feature illustrations. The UI is
  recreated with enlarged labels, simplified content, softly lit backgrounds
  and slightly overlapping floating panels. These are illustrative views of
  existing capabilities, not literal application screens.
- [../readme-banner.png](../readme-banner.png) and
  [dark variant](../readme-banner-dark.png): 1600×1000 covers, selected through
  `cover.light` and `cover.dark`. A large headline and floating schedule frame
  pair with a slightly overlapping conceptual assignment panel. Both the
  background and panel styling follow the selected theme; the README uses `<picture>`.
- [../previews/website-gallery.json](../previews/website-gallery.json): ordered
  image data with `src`, `alt`, `caption`, `width` and `height` for the website.
- [../scripts/feature-concepts.mjs](../scripts/feature-concepts.mjs): reusable
  HTML/CSS/SVG source for each conceptual UI composition. Feature PNGs contain
  no embedded screenshots.
- [../scripts/build-previews.mjs](../scripts/build-previews.mjs): validates PNG
  sizes and source-code paths, builds HTML compositions, imports TaskWindow captures,
  and rejects stale outputs using hashes of the composition and saved PNG.

## Recapture safely

Use Node 22.18+ and install the app dependencies. Use a fresh isolated database;
the seed refuses an API with existing customers, jobs or technicians. Stop any
other local API using port 8787 before starting this preview server.

```sh
preview_db=$(mktemp -d /tmp/openfieldservice-preview.XXXXXX)
node scripts/setup-db.mjs "$preview_db"
pnpm exec wrangler dev --local --port 8787 --persist-to "$preview_db"
```

In another terminal:

```sh
node scripts/seed-preview.mjs
pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort
```

The seed prints fresh UUID routes and writes them to
`/tmp/openfieldservice-preview-routes.json`. Dates are relative to the capture
day so the dashboard and calendar contain visits. The UUIDs in the committed
manifest describe the original capture; use the new routes when recapturing.

1. Open the app through TaskWindow. Use its responsive view at 1440×960 and
   verify the page's `innerWidth`. Capture only the selected README cover view
   in light and dark themes; this set uses an emulated touch viewport.
2. Wait for fonts, data and nested equipment lookups. Confirm no loading,
   errors, open menus or browser chrome obscure the view. Screenshot with
   `save_to_disk: true`, then copy the PNG into this folder.
3. Capture real dark styling for the selected cover view. This set activated
   the existing `(prefers-color-scheme: dark)` CSS media rule through CSSOM in
   the disposable capture tab. Reload to reset; no source styling was changed.
4. Review both cover screenshots, including table edges.
   Update manifest dates, source revision, routes and actual PNG dimensions.
   Never replace customer data in the DOM to invent a feature.
5. Keep only the selected cover screenshots in this folder. Inspect other app
   sections as needed without saving a screenshot gallery. Update the feature illustrations in
   `scripts/feature-concepts.mjs` as capabilities change. Focus each image on
   one relatable task, with large readable labels and at most two related
   floating panels. Overlap their edges slightly; leave key content visible.
   Use layers, soft shadows and background colour to integrate the panels.
   Keep the artwork free of footer disclaimers such as “Illustrative UI” or
   “Example data”. Document the conceptual treatment here and in image alt
   text; do not imply unbuilt features.

## Build the cover and feature cards

```sh
pnpm previews:build
python3 -m http.server 4176 --bind 127.0.0.1 --directory .preview-build
```

Open `http://127.0.0.1:4176/` with TaskWindow to review all compositions. Open
each individual HTML file in a 1600×1000 responsive view, verify that the page
sees that size and all images/fonts have loaded, then capture the viewport.

```sh
node scripts/build-previews.mjs import dispatch /path/to/taskwindow-capture.png
# Repeat for job-work, equipment-history, invoicing, cover-light, cover-dark.
pnpm previews:export
pnpm previews:check
```

`import` validates dimensions and records the rendered composition's hash.
After changing source screenshots, the icon, cover choice or conceptual illustration,
rebuild and recapture the affected outputs. `check` catches stale or missing
PNGs. Review the images visually as well; a hash does not prove a good capture.
`.preview-build/` is disposable, ignored by Git and outside the shipped app.

## Use in the template carousel

Copy only the exported `previews/` PNGs to the website's static
assets, preserving those subpaths under `/assets/apps/open-fieldservice/`.
Import the exported JSON and map each `src` to that prefix:

```ts
const images = gallery.map(image => ({
  ...image,
  src: `/assets/apps/open-fieldservice/${image.src}`,
}));
```

These objects match the current website's `AppImage` shape. Omit `bannerTop`:
these are standalone images. Use `object-fit: contain` and the supplied aspect
ratio to show the whole composition. The carousel contains the four conceptual
feature illustrations. The two raw cover sources stay in this repository
solely to regenerate the README images.
Copy assets at build time or use a pinned Git commit URL so an app update does
not silently change a published website. Lazy-load slides after the first.

This repository supplies the assets and export; publishing the website is a
separate step. The manifest's single `screenshot` URL points to the raw schedule
on `main`.
