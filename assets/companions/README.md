# Cushion companions

Production artwork generated with the built-in ImageGen tool on 27 October 2026 after the owner requested implementation of the pearl/fluid interface and cushion creatures. The likeness references are the character sheet and desktop/phone study in `prototypes/ui-cushion-creatures-v10-20261027/`. The source images below have actual transparent alpha. No opaque concept-sheet background was color-keyed or shipped as an avatar.

- `cushion-family-source.png`: near-frontal full bodies, row-major Blue Atlas, Coral Nova, Jade Scout, Honey Echo.
- `cushion-portraits-source.png`: dedicated upper-body artwork of the same four companions, in the same order, without feet or baked glass frames.
- `layout.json`: exact extraction rectangles for the generated sources. Different silhouettes retain their proportions instead of being stretched into the same body shape.
- `generation-prompts.txt`: the prompts used for both source atlases, with their reference roles.

Run `node scripts/build-companion-assets.mjs` to produce `public/assets/companions/companion-{blue,coral,jade,honey}-{portrait,mascot}-{32,64,128,256,512}.{webp,png}` and its manifest. The build checks source dimensions and alpha, crops the recorded regions, scales proportionally, preserves transparency and encodes local exports. It performs no image generation, recoloring or network request. Both original atlases are preserved.

`public/creature-avatars.js` selects these finite local assets. Canonical `bot_atlas`, `bot_nova`, `bot_scout` and `bot_echo` IDs select blue, coral, jade and honey even if their names change. Imported bots with those exact names receive the same assignment. Other bots receive a stable variant from their ID hash. A bounded saved `companion:<variant>` icon seed keeps a new bot's preview stable when the server assigns its ID. Existing saved icon, name and color fields are not rewritten. Saved color palettes continue to color recorded activity visuals independently of the portrait.

Normal avatars are still upper-body portraits, at 52px in small contexts and 40px in tiny contexts. Only explicit single-bot welcomes and profile heroes request full-body mascots. Task-state metadata remains available, but portraits keep calm open eyes and do not claim to depict private reasoning. Large mascots use restrained CSS breathing/tilting and bounded success/greeting gestures; small, paused and reduced-motion avatars stay still. `data-roki-*` attributes remain internal compatibility metadata, not a request to load the earlier character.

`/companions-preview.html` reviews both presentations, actual interface sizes, task-state metadata and the pause control without accessing account data. These are rendered images with CSS motion, not rigged or frame-by-frame character animation. The earlier `assets/roki/` sources and shipped exports remain preserved historical artwork.

## Twenty animated additions

At the owner's request the catalog now contains 24 companions. The original four and their artwork remain preserved. `catalog.json` is the finite identity/name/motion/source registry; `public/companion-catalog.js` is generated from it. Adding entries does not reassign existing implicit bot identities. An explicit `companion:<id>` selects any catalogued character.

`expansion-a/` and `expansion-b/` contain twenty separate built-in imagegen outputs, one 2×2 pose sheet per new character. Row-major frames are idle/open eyes, fully closed blink, curious look and one-arm wave. Each directory records exact prompts, original dimensions/alpha and inspection metadata. The generated originals are preserved; no palette recoloring substitutes for a new generation. These raster sources contain straight-alpha RGB edge detail; inspect their actual RGBA compositing rather than a viewer that drops alpha. Browser checks on white and dark surfaces show clean silhouettes. Packaging never color-keys or repaints them.

The builder extracts each quadrant, measures the largest alpha-connected component for crop/alignment, uses one scale and a foot anchor across poses, then derives a fixed portrait crop from the idle pose. It preserves source alpha and encodes local registered WebP frames named `companion-<id>-<portrait|mascot>[-<blink|look|wave>]-<size>.webp`. New idle presentations also have 512px PNGs. `registration.json` records the measured bounds and crop. `companion-<id>-animated.webp` is a transparent seven-frame portable loop including the blink/look/wave poses; it is a presentation animation rather than task telemetry.

This request supersedes the earlier still-portrait rule above: all interface sizes now have restrained body motion. The new twenty use actual pose layers for brief staggered blinks, look/wave states and hover/keyboard-focus greetings. The original four animate their existing body artwork without requesting missing sprite frames. Pause and Reduce Motion force the idle image with no transforms/blinking. Shared observers suspend offscreen/hidden-page motion and unregister removed nodes. No per-avatar JavaScript timers run.

`/companions-preview.html` uses the production catalog, renderer, frames and pause/state controls. The portable gallery/download bundle lives in `prototypes/companions-20-animated-20261028/`.
