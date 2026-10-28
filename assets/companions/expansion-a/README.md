# Cushion companion expansion A

Ten original cushion characters generated with ten separate built-in ImageGen calls. Every character uses `../cushion-family-source.png` as a construction/material reference. No character is a programmatic recolor of another output. Original generated sheets are preserved unchanged.

The identities are Cloud, Tangerine, Lagoon, Cherry, Pistachio, Periwinkle, Peach, Lemon, Rose and Teal. Each source has four complete full-body poses, in a 2×2 row-major layout: idle, fully closed blink, curious lean and one-arm wave. All sources returned at 1254×1254 pixels with actual RGBA alpha, so each grid cell is 627×627 pixels. Requested generation dimensions are not assumed by the manifest.

`manifest.json` lists all ten original sources and their SHA-256 digests. Each `<id>-prompt.txt` records the exact prompt and reference role. Each `<id>-metadata.json` records dimensions, actual transparency, per-frame cell locations, largest connected-character bounds at alpha >128, a shared relative crop union and visual inspection notes.

All ten sheets were visually inspected: open upright oval eyes in idle; both eyes fully closed in blink; a visible slight curious lean; a raised arm in wave; complete feet and bodies. No text, accessories, floor or baked opaque background is present. Some images include faint disconnected alpha flecks outside the character. Sources retain those pixels; downstream packaging can isolate the largest connected character while preserving a small antialiasing margin. Do not replace transparency with a color key.

For stable animation, use one consistent scale and placement across a character's four frames; avoid independently fitting every pose to a different square. The shared crop union is a starting point. Leave roughly 3–4 source pixels around the opaque component to retain antialiased fabric edges. These source sheets do not themselves install or enable any runtime animation.
