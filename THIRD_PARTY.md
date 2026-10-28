# Third-party software and notices

Tupies 0.3.0 contains original Tupies Engine and interface source, plus the open-source packages and assets listed below. The project's MIT license does not replace their licenses. Product names including Hermes Agent/Nous Research, Grok/xAI, OpenAI/Codex, Anthropic and Apple belong to their owners; no affiliation or endorsement is implied.

## Packages

Versions are pinned in [package.json](package.json) and [package-lock.json](package-lock.json). Production installs use `npm ci --omit=dev`; builds/tests additionally use the development packages. Browser libraries are bundled locally rather than loaded from a CDN.

| Direct package | Version | Purpose | Declared license |
| --- | --- | --- | --- |
| chart.js | 4.6.1 | Interactive charts | MIT |
| docx | 9.14.0 | Word generation | MIT |
| dompurify | 3.4.17 | Browser HTML/SVG sanitization | MPL-2.0 OR Apache-2.0 |
| exceljs | 4.4.0 | Workbook reading/writing | MIT |
| fast-xml-parser | 5.11.2 | Office XML parsing | MIT |
| fflate | 0.8.3 | Archive processing | MIT |
| highlight.js | 11.12.0 | Code highlighting and theme | BSD-3-Clause |
| katex | 0.19.1 | Mathematics and local font assets | MIT for code/CSS; font terms below |
| mammoth | 1.13.0 | Word content extraction | BSD-2-Clause |
| marked | 18.1.2 | Markdown | MIT |
| mermaid | 12.2.0 | Diagrams | MIT |
| pdfjs-dist | 6.4.299 | PDF parsing, browser rendering and resource assets | Apache-2.0; resource notices below |
| pdfkit | 0.20.2 | PDF generation | MIT |
| pptxgenjs | 4.0.1 | Presentation generation | MIT |
| qrcode-generator | 2.0.4 | Pairing QR codes | MIT |
| sharp | 0.35.5 | Chart image rendering | Apache-2.0; native library notices below |
| svg-to-pdfkit | 0.1.8 | SVG/PDF rendering support | MIT |
| unpdf | 1.9.1 | PDF processing support | MIT |
| esbuild (development) | 0.28.2 | Browser bundling | MIT |
| jsdom (development) | 30.1.3 | Browser regression fixtures | MIT |

The dependency graph includes additional packages with their own licenses, including native Sharp/libvips components and Mermaid layout dependencies. [assets/licenses/dependencies.json](assets/licenses/dependencies.json) records installed package names, versions and declared licenses. [assets/licenses/THIRD_PARTY_LICENSES.txt](assets/licenses/THIRD_PARTY_LICENSES.txt) contains the package license/notice texts found by the collector. `npm run licenses:build` refreshes both from the installed dependency tree; `npm run build` includes that step. Platform-specific native packages differ between Mac, Linux and other installations. These generated files also include development dependencies when present during the build.

Sharp's platform-specific libvips packages declare LGPL-3.0-or-later and include libraries under several other terms. Their package README lists the constituent libraries and licenses; see the [sharp-libvips source/build project](https://github.com/lovell/sharp-libvips) and each installed `@img/sharp-libvips-*` package's README/versions manifest. These are separate from Sharp's Apache-2.0 JavaScript license. Preserve the component notices and applicable source/license material when redistributing a native runtime image.

## Fonts, PDF resources and browser assets

| Shipped asset | License/notice location |
| --- | --- |
| Noto Sans Regular and Bold in assets/fonts/ | SIL Open Font License 1.1: [assets/fonts/OFL.txt](assets/fonts/OFL.txt). Includes the Noto Project notice and Google copyright embedded in the font. Used for generated documents. |
| KaTeX CSS/code in public/vendor/ | KaTeX MIT license, retained in the generated package notices and installed katex package. |
| KaTeX fonts in public/vendor/fonts/ | SIL Open Font License 1.1, as declared in the embedded font name tables: [assets/licenses/KaTeX-FONTS-OFL.txt](assets/licenses/KaTeX-FONTS-OFL.txt), also copied to public/vendor/fonts/OFL.txt. Includes Design Science/Khan Academy copyright and reserved font names. |
| PDF.js browser code and worker in public/vendor/ | Apache-2.0; pdfjs-dist package notices are retained in the generated package notices. |
| PDF.js CMaps | Adobe redistribution notice in [public/vendor/cmaps/LICENSE](public/vendor/cmaps/LICENSE). |
| PDF.js Foxit standard fonts | PDFium/BSD-style three-clause notice in [public/vendor/standard_fonts/LICENSE_FOXIT](public/vendor/standard_fonts/LICENSE_FOXIT). |
| PDF.js Liberation standard fonts | GPL version 2 with the font embedding exceptions stated in [public/vendor/standard_fonts/LICENSE_LIBERATION](public/vendor/standard_fonts/LICENSE_LIBERATION). |
| PDF.js WebAssembly codecs/color support | Separate PDF.js, OpenJPEG, JBIG2 and qcms notices retained in public/vendor/wasm/ as LICENSE_PDFJS_OPENJPEG, LICENSE_OPENJPEG, LICENSE_PDFJS_JBIG2, LICENSE_JBIG2, LICENSE_PDFJS_QCMS and LICENSE_QCMS. |

The rich content bundle retains embedded legal comments. Its highlight.js CSS, KaTeX CSS/fonts and PDF.js resources are copied from the pinned packages by `scripts/build-assets.mjs`. Keep their notice files when copying or repackaging public/vendor/. The interface otherwise uses original HTML/CSS/SVG and system fonts; Apple/xAI proprietary code, artwork and authenticated application resources are not bundled.

The container uses an official Node Debian slim image pinned by digest, plus distribution Python 3, Bash and certificate packages for reviewed skill execution. Those runtimes and their dependencies retain their own licenses/notices in the base image and installed distributions. Additional skill packages are selected and maintained separately by the operator; importing a skill does not install them.

## Agent and protocol references

The open-source [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) was inspected at revision `9976f4857b72439d79016354d7b6e1a3ee952e2f` to understand the requested capabilities. Its [license](https://github.com/NousResearch/hermes-agent/blob/9976f4857b72439d79016354d7b6e1a3ee952e2f/LICENSE) is MIT, Copyright 2025 Nous Research. Tupies does not vendor, install, start or call that agent runtime, and does not use its private credential stores. No Hermes or Codex runtime is distributed or required.

Provider adapters implement documented public Responses, Messages and compatible API protocols. The ChatGPT adapter implements the public-client Sign in with ChatGPT flow and public Responses API; it does not borrow Codex OAuth tokens, use a private client ID or call ChatGPT backend endpoints. Local open-source registration and paid/remotely hosted plan integration have different eligibility boundaries.

The MCP client implements Streamable HTTP JSON-RPC initialization, tool discovery and invocation. Primary references and scope limits are listed in [docs/research.md](docs/research.md).
