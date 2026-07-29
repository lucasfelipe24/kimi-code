# Kimi Documents

Official document toolkit for Kimi Code: create, edit, validate, and render office documents.

## Skills

- **pdf** — PDF creation via HTML+Paged.js (default) or LaTeX (on explicit request), plus processing of existing PDFs (extract, merge, split, forms, metadata).
- **xlsx** — Spreadsheet creation and analysis with Python openpyxl/pandas, plus a bundled native `Xlsx` CLI for OpenXML validation, recalculation, pivot tables, and inspection.
- **docx** — Word documents: md2docx for Markdown-to-Word, C# + OpenXML SDK for from-scratch creation (requires dotnet), WIR engine for editing existing `.docx` while preserving formatting.
- **slides** — Presentations authored in the `.pptd` YAML DSL, with the bundled native `kimi-slides` CLI for pptx→pptd conversion, validation (`check`), and screenshot rendering. Bundled fonts included.
- **documents** — Router skill that picks the right route per request.

## Environment

Run `scripts/setup.sh --json` for a full status report (it never installs anything).

- Native binaries (`kimi-slides`, `Xlsx`) are bundled for **linux-x64 only**. On other platforms the pure-Python routes keep working and the skills document their fallbacks.
- Python dependencies (openpyxl, pandas, pypdf, matplotlib) must be installed inside a virtual environment.
- The pdf HTML route needs Node.js and a Chromium/Playwright browser.
- Optional: dotnet (docx Create route), LibreOffice (xlsx recheck, `.doc` conversion), Tectonic/LaTeX (pdf LaTeX route).

## License

Moonshot AI Skill License — see `LICENSE.txt`.
