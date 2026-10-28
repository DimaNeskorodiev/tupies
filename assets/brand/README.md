# Tupies identity

`tupies-avatar.png` is the canonical transparent mascot master. The cream plush cushion, black pill eyes, short feet and raised mitten hand follow the owner's supplied Tupies reference. It was created with the built-in ImageGen tool on 28 October 2026. The original generated alpha is retained; the build does not color-key or recolor the character.

Run `npm run brand:build` to regenerate:

- `public/assets/brand/tupies-avatar.{png,webp}` for loading, sign-in, sidebar and system-message marks.
- A self-contained `tupies-mark.svg`, 16/32/64px PNG favicons and an opaque 180px Apple touch icon. Compact favicons crop to the face for legibility.
- Full-resolution Graphite (default), Pearl and Sky icon backgrounds and `brand-preview.png` for comparison. These variants share the same character and pose.
- The opaque iOS app icon, inset rounded macOS app icons, and `TupiesAvatar.imageset` for native onboarding/connection/pairing screens.

The build derives its paths from this checkout. `TUPIES_BUILD_WEB_ONLY=1` skips native output for engine/container builds. Ship the generated web and Apple assets together with the source master. Installing rebuilt Apple apps and deploying web assets are separate from generating them; this source update does not restart operational engines or replace installed apps.

## Generation prompt

The built-in tool used the owner's attached character as its sole image reference, with transparent background enabled:

> Use case: identity-preserve. Asset type: Tupies application mascot master, a square high-resolution transparent PNG for app icons and a web logo. Input image 1 is the character identity reference. Recreate this exact cream cushion creature: softly squared plush body, warm ivory fuzzy velour texture, two glossy vertical black pill eyes, no mouth, short rounded feet and mitten hands. Preserve its proportions, appealing simple face and premium soft 3D rendering. Front three-quarter view, facing the viewer, one hand raised in a friendly wave as in the reference. The whole character, including feet and raised hand, fully visible, centered within a square canvas, with generous clean transparent space around all edges. The character should occupy about 82% of the width and 80% of the height. Clean production-quality cutout with actual transparent alpha, no white matte, no background, no floor, no cast shadow extending beyond character. Soft upper-left studio lighting, delicate contact shadows on character only. No text, no letters, no icon tile, no border, no extra objects, no mouth, no new accessories.
