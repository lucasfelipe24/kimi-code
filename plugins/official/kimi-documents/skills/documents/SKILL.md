---
name: documents
description: Entry point for office-document tasks. Routes to the pdf, xlsx, docx, or slides skill based on the requested document type. Use whenever the user wants to create, edit, convert, validate, or render PDF, XLSX, DOCX, or presentation files.
---

# documents — routing skill

This plugin bundles four document skills. Pick exactly one route per deliverable:

| Request | Skill | Directory |
|---|---|---|
| Create a PDF (report, paper, document) | `pdf` (HTML route) | `../pdf/` |
| Create a PDF with explicit LaTeX/.tex request | `pdf` (LaTeX route) | `../pdf/` |
| Extract/merge/split/fill an existing PDF | `pdf` (Process route) | `../pdf/` |
| Create or analyze a spreadsheet (xlsx/xlsm/csv) | `xlsx` | `../xlsx/` |
| Create a Word document from Markdown | `docx` (md2docx route) | `../docx/` |
| Edit an existing .docx preserving formatting | `docx` (WIR route) | `../docx/` |
| Create a Word document from scratch | `docx` (Create route, needs dotnet) | `../docx/` |
| Create or edit a presentation | `slides` (.pptd DSL) | `../slides/` |
| Convert an existing .pptx for editing | `slides` (convert) | `../slides/` |

## Rules

1. Read the target skill's `SKILL.md` before doing any work — each skill has mandatory routes and references not duplicated here.
2. Run the plugin's environment check first: `scripts/setup.sh --json` (relative to the plugin root, two directories up from this file). It never installs anything.
3. Install Python dependencies only inside a virtual environment.
4. Bundled native binaries (kimi-slides CLI, Xlsx CLI) work on linux-x64 only; on other platforms follow each skill's documented fallback.
5. Deliver artifacts as normal files in the user's workspace.
