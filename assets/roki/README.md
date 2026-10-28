# Roki character assets

Canonical graphite Roki, introduced 27 October 2026 from the owner's attached character reference. Artwork was generated with the built-in ImageGen tool and packaged locally. The owner then selected **Portrait + mascot** for the Mac: dedicated compact portraits for the working interface and the original full-body character for single-bot welcomes/profile heroes. This is a context-specific rendering treatment, not a selectable character or color variation. Per-bot appearance customization still waits for approval of the base direction.

## Sources

- `roki-reference.png`: the user-supplied visual reference.
- `roki-portraits-source.png`: transparent 3×2 atlas, row-major: idle, happy, focused, curious, blink, sleepy. These are dedicated head portraits with simpler matte graphite surfaces and soft, even light. They have no sneakers, limbs, props, cast shadows or baked container background. The runtime supplies the neutral glass frame.
- `roki-poses-source.png`: original transparent 3×3 full-body atlas, row-major: idle, blink, look, thinking, working, success, greeting, sad, floating.
- `roki-expressions-source.png`: original transparent 4×2 full-body expression atlas: default, happy, focused, curious, sleepy, excited, surprised, winking.
- `roki-turnaround-source.png`: original transparent 4×2 full-body turnaround atlas: front, front-right, right, back-right, back, back-left, left, front-left.

The original full-body prompts requested consistent cell placement, a graphite faceted rock with a recessed dark face, warm glowing eyes, an orange side insert and cream sneakers with black straps and orange soles, actual transparent alpha, and no floor, labels, text or color variants. Compact portraits retain the recognizable face and orange insert while reducing texture, harsh shading and detail that become noise at small sizes. They are separate renders rather than crops of the full-body sprites. These are rendered pose/expression assets, not a rigged 3D model or frame-by-frame locomotion footage.

## Build and presentation

Run `npm run avatars:build` (also part of `npm run build`) to package source atlases with Sharp into `public/assets/roki/`. Portrait exports use `roki-portrait-{idle,happy,focused,curious,blink,sleepy}-{32,64,128,256,512}.webp`, with idle PNG icons at the same sizes. Existing full-body WebP poses and idle PNG icons remain at 32/64/128/256/512px; original expression and turnaround exports remain at 256px. Alpha is preserved. Do not hand-edit generated exports; replace the source atlas and rebuild.

`public/creature-avatars.js` owns bounded local asset selection and defaults to portraits. Interface lists, cards, headers, transcript messages, the inspector, settings and room-welcome stacks use still portraits in a consistent neutral glass frame. Run state maps to a still facial expression: idle/floating → idle, blink → blink, look → curious, thinking/working → focused, success/greeting → happy, sad → sleepy. There is no portrait hover swap, body bob, looping blink or prop animation.

Full-body presentation is an explicit choice for a single-bot chat welcome or profile hero. `public/creature-avatars.css` supplies that mascot's breathing, blinking, tilting, greeting, hopping and floating motions. Paused mascots stay still and reduced-motion preferences disable motion. Brief success/error expressions expire after 12 seconds. Saved palette metadata still colors activity-flow visuals without recoloring Roki. No network image service is needed at runtime.

Review the portrait and mascot treatments at `/roki-preview.html` on a running engine. The original full-body expression/turnaround exports remain design references. This iteration is authorized only on the Mac; do not contact or update the VPS from this workflow. Record actual checks and delivery in `docs/verification.md` before claiming verification.
