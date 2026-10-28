# Rich chat and documents

Tupies 0.4.0 can read attached documents, display structured answers and create downloadable files inside each bot's private workspace. Ask for the outcome in ordinary language; the bot chooses its available tools.

- “Compare these two PDFs and give me a table of the differences.”
- “Turn this plan into a Word document and a five-slide presentation.”
- “Create an Excel budget with a totals formula, then read it back to check it.”
- “Show this data as a line chart and save a PDF report.”

## Attach files to a task

Use the **+** button beside a bot's message box. Selected files appear as chips; remove a chip to leave that file out of the task. You can send up to five files with a combined size of 20 MB (20,000,000 bytes), with or without a text message. Composer attachments are available in individual bot chats.

Choosing a file saves its bytes in that bot's local workspace. It does not start a model request or extract the document. **Send** associates the selected files with the message and gives the provider their private relative paths. The bot can then call `documents_read` for relevant text. Opening a preview is a separate, explicit local read. Removing a chip does not delete the uploaded workspace file.

| Format | Read and preview | Create a download |
| --- | --- | --- |
| PDF (`.pdf`) | Rendered pages and extractable text | PDF report |
| Word (`.docx`) | Document content, tables and supported embedded images | Word document |
| PowerPoint (`.pptx`) | Slide titles, text, tables and supported cached chart data | Presentation |
| Excel (`.xlsx`) | Sheets, cells, formulas and available cached results | Workbook |
| Markdown (`.md`), UTF-8 text (`.txt`), CSV (`.csv`), JSON (`.json`) | Text or table preview | Corresponding file |
| PNG, JPEG, WebP | Image preview for the user; shown to the bot's model when it can see images | Existing images can be downloaded; image generation is not included |

PDF reading extracts text; scanned pages need OCR, which is not included. Legacy Office binaries such as `.doc`, `.ppt` and `.xls`, macro-enabled documents and embedded executable objects are unsupported.

Office previews show document content, rather than reproducing every font, animation, layout or editing feature. Open the download in its usual application for the complete document. Browser previews show up to 30 PDF pages, 50 slides or 20 sheets; spreadsheet previews contain up to 200 rows per sheet and may shorten long cells. Warnings identify additional extraction limits.

### Images the bot can see

When the bot's model can see images, an attached PNG, JPEG or WebP is shown to it with the message. A model that can read images can then read the text in a screenshot or photo too. Before sending, Tupies fits each image in the document worker: it turns it upright, scales it to fit a 1568-pixel edge and about 1.15 megapixels, and keeps it PNG (screenshots stay sharp) or makes it JPEG.

- **Which models.** Tupies uses, in this order: **Settings › Models › provider › Advanced endpoint settings › Image input** (Automatic, Models here can see images, or Text only); what the provider's model list declares (OpenRouter and the ChatGPT/Codex catalog list input types); then well-known families (current ChatGPT/Codex models, GPT-4o/4.1/5/6, o1/o3/o4, Claude, Gemini, Grok 4). Anything else is treated as text-only. **Chat options** says whether the selected model is shown attached images.
- **A model that refuses images.** If the provider rejects an image, that step is sent again once without images (no tool runs twice). The model is then remembered as text-only for this provider, unless you set **Image input** to on.
- **Text-only models.** They get the file names and a note saying they cannot see the images. The composer warns when you attach an image to such a bot.
- **Which images.** The model sees the newest five images still in the conversation, so it can answer follow-up questions about them. Older ones, and any file that changed or moved since it was attached, get a short note instead. Images stay files in the bot's workspace; the conversation stores only their names and sizes, so image data never goes into `state.json` or sync.
- **Cost.** Each image shown costs about as many tokens as its pixels ÷ 750 (at most about 1,600) on every model step of the task, which is counted toward the working context.

Image content is untrusted task data, like a document. An image cannot grant permissions.

## Follow the bot's activity

During a task, the chat's transparent activity flow carries real actions, sources and observed result values through a changing graph. Research, document analysis, visible plans and teammate exchanges use different arrangements; a streaming reply uses a compact version. Tap or keyboard-activate a moving fragment to inspect its recorded display value and details. The flow uses bounded run events and tool previews, marks incomplete previews, and does not expose private reasoning or imply that a planned step has succeeded. See [Activity flow](chat-controls.md#activity-flow) for reading holds, reduced motion and other controls.

## Rich answers

The chat renders Markdown headings, lists, tables, links and highlighted code with a copy button. Math uses `$...$` or `$$...$$`. Fenced `mermaid` blocks render supported diagrams. Diagrams cannot contain external links, custom directives or executable HTML.

Charts use a fenced `chart` block containing JSON. Supported inline types are `bar`, `line`, `area`, `pie`, `doughnut` and `scatter`. A chart includes its data table and PNG, SVG and CSV download buttons. For example:

````markdown
```chart
{
  "type": "line",
  "title": "Completed tasks",
  "labels": ["Mon", "Tue", "Wed"],
  "datasets": [{"label": "Done", "values": [4, 7, 9]}]
}
```
````

A fenced `infographic` block accepts a title, subtitle, metrics and steps:

````markdown
```infographic
{
  "title": "Release readiness",
  "subtitle": "Three checks remain",
  "metrics": [{"label": "Checks passed", "value": "12", "detail": "Of 15 checks"}],
  "steps": [{"title": "Review", "description": "Resolve the remaining findings."}]
}
```
````

These are bounded presentation formats. Arbitrary HTML, JavaScript, remote images and embedded applications do not run inside a reply. Invalid or oversized visuals show an explanation and their source instead of executing code. Inline charts support up to 12 series and 200 values per series; each visual source is limited to 16,000 characters.

## Create and verify a file

Ask the bot to save a PDF, DOCX, PPTX, XLSX, Markdown, CSV, text or JSON file. It must call `documents_create` successfully before claiming that the export exists. The engine attaches the actual file to the final reply automatically. Each card offers **Preview** and **Download**; the file also remains in the bot's workspace. These links require your Tupies session and are not public sharing links.

Under **Balanced** policy, creating or replacing a private document can proceed automatically. Under **Strict** policy, Tupies asks you to approve the exact output path and complete document specification first. Deleting a file still requires approval under both policies. A file committed before a task fails or is stopped remains available with an explicit partial task status; cancellation does not pretend the whole task completed.

The document tools belong to the existing `workspace` tool group. `documents_read` takes a relative path and optional `maxChars` (100–100,000; default 60,000). It returns extracted text, preview structure, warnings and a truncation flag. The bot should read the result before saying it inspected a file.

For integrations or custom model instructions, `documents_create` takes `{path,document}`. The filename extension selects the output format. This is a valid PDF specification:

```json
{
  "path": "reports/weekly-review.pdf",
  "document": {
    "title": "Weekly review",
    "subtitle": "Delivery team",
    "blocks": [
      {"type": "heading", "level": 2, "text": "Progress"},
      {"type": "paragraph", "text": "The team completed the planned review."},
      {"type": "list", "items": ["Review claims", "Confirm next steps"]},
      {"type": "table", "headers": ["Day", "Done"], "rows": [["Mon", 4], ["Tue", 7]]},
      {
        "type": "chart",
        "chart": {
          "type": "bar",
          "title": "Completed tasks",
          "labels": ["Mon", "Tue"],
          "series": [{"name": "Done", "values": [4, 7]}]
        }
      },
      {"type": "page_break"},
      {"type": "paragraph", "text": "Next review: Friday."}
    ]
  }
}
```

Use `content` for Markdown-based content, `blocks` for explicit document structure, `slides` for a presentation, or `sheets` for a workbook. Markdown exports preserve authored formatting, code fences, Mermaid and chart fences. Explicit chart blocks become fenced chart JSON in Markdown. Exported chart blocks support **bar, line and pie** charts. Native documents embed them as chart images; workbooks also include their data, and presentations retain bounded chart data for text and chart previews. Other inline chart types are available through the chat chart's download buttons.

PowerPoint inspection can read supported native chart XML caches without opening embedded workbooks. Available bar, line and pie caches appear as charts; unsupported or incomplete caches appear as data tables with a warning. Cached values may be stale. Text and data previews do not reproduce the full slide layout; download the presentation to inspect its appearance.

A presentation can use `"path":"slides/plan.pptx"` with `"document":{"title":"Plan","slides":[{"title":"Next steps","content":"- Review evidence\n- Agree the release date"}]}`. A workbook uses rows of cell values:

```json
{
  "path": "sheets/budget.xlsx",
  "document": {
    "title": "Budget",
    "sheets": [{
      "name": "Budget",
      "rows": [
        ["Item", "Cost"],
        ["Research", 120],
        ["Design", 180],
        ["Total", {"formula": "SUM(B2:B3)"}]
      ]
    }]
  }
}
```

CSV exports use the first supplied sheet or table. JSON exports serialize the validated document specification, including its title/content/blocks, rather than arbitrary top-level fields. Use a text or workspace write when a task needs a different raw data shape.

Workbook formulas support bounded local references, arithmetic and selected aggregate functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND and ABS. Simple results are cached when Tupies can calculate them. Other accepted formulas are preserved with a recalculation warning; open the workbook in Excel or another spreadsheet application to recalculate. Imported formula caches may be stale. A string beginning with `=` remains literal text and produces a warning; use a formula object such as `{"formula":"SUM(B2:B4)"}` for a calculated cell. External references and executable formulas are rejected. Formula-like CSV text is escaped rather than executed.

Model tool arguments are limited to 150 KB. Each input or output file is limited to 20 MB. Additional document limits include 100 PDF pages or presentation slides, 32 sheets and 50,000 cells. Large work is best split into smaller documents; a shortened preview does not mean the original file was shortened.

The engine's standing instructions describe these rich formats, require real tool results for file claims, and treat attached content as task data. A document cannot grant permissions, change the bot's policy or authorize an external action.
