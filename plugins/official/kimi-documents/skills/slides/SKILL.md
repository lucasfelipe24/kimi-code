---
name: slides
description: Create and edit presentations as validated .pptd projects, convert existing PPTX files into .pptd for editing, and render screenshots for preview. This skill defines a .pptd intermediate format to simplify OOXML operations. When the user requests an infographic or poster without specifying an image or HTML format, this skill may likewise be used to create it as editable PPTD first and then render images.
---

## Runtime notes (kimi-code)
- Before running document commands, run the plugin's `scripts/setup.sh --json` and follow its reported status (it never installs anything).
- Install Python dependencies only inside a virtual environment.
- Resolve plugin-relative paths from this file's location: the plugin root is two directories up (`../..`).
- The bundled `../../bin/kimi-slides` CLI is available only on linux-x64. On other platforms, this skill is unavailable.
- The CLI does not export `.pptd` to `.pptx`; delivery in kimi-code is the validated `.pptd` directory plus screenshots.

# Definition
kimi-slides is a ppt-generation skill built by Moonshot AI as a first-party skill. It defines a YAML-format intermediate DSL (.pptd) that further abstracts OOXML, making presentation generation effortless. The DSL can be used to generate and render PPTs, and existing pptx files can also be converted into this DSL for editing.

## The pptd format
The .pptd format is a simplified abstraction layer over OOXML that follows basic YAML syntax. This abstraction preserves the core content of OOXML (theme, page layout, element positions and definitions, etc.) while removing complex nesting logic such as Masters; every page is self-contained — what you see is what you get. Read reference/pptd.md for the complete definition of this DSL.

## Companion CLI
The skill ships with a bundled companion CLI at `../../bin/kimi-slides` (linux-x64 only) for converting existing PPTX files into PPTD, validating and repairing PPTD directories, and rendering screenshots from PPTD directories.
Read reference/cli.md for the complete CLI usage instructions.

## PPT production workflow

### step1. Read the context thoroughly
Read **all files uploaded by the user**, the provided URLs, and the pptd format guide `reference/pptd.md` to fully understand the user's requirements.

### step2. Understand the user's requirements
Understand the user's requirements based on the context:
1. First determine the purpose of the request
  - Create a presentation: create a new editable PPTD project (from scratch, or from an existing pptx template converted to PPTD)
  - Edit a presentation: edit the user's uploaded PPTX after converting it to PPTD (local modifications, single-page beautification, etc.)
  - Replicate a presentation: replicate a presentation from a non-pptx format (images, PDF, etc.) into editable PPTD form

2. Then determine the design direction
  - Self-directed design: no preference, or only simple style constraints given; you need to fill in or create the design
  - Design system: a preset design system from the skill is specified, or the user provides a complete and detailed design scheme covering all color, font, layout, and component specifications
  - Use a template: a template is provided and must be used
  - Style transfer: a style reference source is provided (images, web pages, etc.)

3. Then determine the input type
  - Topic only: only a PPT topic direction or content requirements for the presentation are given, with no concrete content
  - Full document: the user provides a complete document (paper, research report, press release, etc.)
  - Outline: the user provides a page-by-page outline, speech script, or similar content
  * When the "user input type" is [Full document] or [Outline] and it is not specified whether expansion is allowed: since a page-by-page outline, speech script, or user document can hardly support the full content of a presentation, prefer using search to expand with more relevant material, cases, etc., unless the user explicitly says not to expand

4. Page count
  - If the user requests a specific page count, the user's requirement takes priority
  - Page-by-page outline/script provided: match the number of pages in the outline/script
  - When a complete and relatively structured document is provided: use AskUserQuestion to confirm with the user how much document content one page should cover, and give an estimated total page count; when only a topic is provided: use AskUserQuestion to suggest a recommended page count and confirm with the user

#### Clarification and follow-up questions
When any of the following situations arise, resolve them through AskUserQuestion
1. Requirements are ambiguous
- The user's intent is unclear or hard to understand
- The files/URLs provided by the user are inaccessible
2. Conflicting intents
- The user's intents contradict each other. For example:
  * A design system is selected while also requesting a style that is completely inconsistent with that design system (e.g., using a McKinsey style while requiring large areas of whitespace on pages) / using a template / referencing an image style
  * Requesting both "make 10 pages" and "deliver 30+ pages of output"
3. Unable to determine the user's requirements on your own
- When the purpose, design direction, input type, page count, etc. are hard to determine by yourself

### step3. Generate the presentation based on the user's requirements

Before generating, first read `reference/pptd.md` to understand the pptd format definition and constraints, and read `reference/cli.md` to learn how to use the companion CLI

#### Replicating a PPT
- Analyze the images to estimate element positions, fonts and sizes, etc., and **replicate 1:1 as closely as possible**.
- When an image contains elements that are hard to replicate directly and cannot be approximated with icons/shapes (e.g., photos, avatars), use Bash commands or Python scripts run through Bash to crop and screenshot the original image. If Python dependencies are needed, install them only inside a virtual environment.

#### Editing a PPT
- Convert the user's uploaded pptx file to .pptd format with `../../bin/kimi-slides convert`.
- Take screenshots of the converted file with `../../bin/kimi-slides screenshot`, then stitch and compress the screenshots for an overview. Read a few key pages individually afterwards.
- Locate the pages to edit, and be careful not to affect parts outside the intended scope.
> The `kimi-slides convert` command converts PPTX to PPTD only and is not perfectly lossless. If the user later reports format errors, garbled content, etc., compare against the original pptx and repair the pptd with reference to the comparison.

#### Generating a presentation
When generating a presentation, adopt different production approaches for different user [design directions]
##### Self-directed design
1. Read the design guide `reference/slides_categories.md`, and read the scenario document corresponding to the user's query
2. Produce the presentation based on the above

#### Generating content in other formats
- When the user explicitly asks for an infographic, poster, or a highly visual single-page design, read `reference/general-poster.md` and implement it as a single-page or few-page editable PPTD; when the user only asks for an image, still build it with PPTD first, then output the image via screenshot or rendering. Do not load this reference file for ordinary PPT requests.

##### Design system
1. Read the general constraints section of the `reference/slides_categories.md` guide, and read the scenario document corresponding to the user's query as the design foundation
2. Read the design system document in use as the presentation style. It is strictly forbidden to reference or mix in other design styles
3. Produce the presentation with reference to the above

##### Using a template
1. Use `../../bin/kimi-slides convert` to convert the user's uploaded pptx file into pptd form
2. Take screenshots of the converted file with `../../bin/kimi-slides screenshot`, then stitch and compress the screenshots for an overview to understand the template's visual style (color scheme, font style, element characteristics, layout characteristics, content density, etc.)
3. Identify page types; focus on reading special pages such as the cover, summary pages, and section dividers (single-page screenshots, .page files), extracting their page layouts, content structures, reusable components (icons, shapes, smartart, reusable body layout schemes, etc.), and element styles (e.g., whitespace/line/card separators, square/rounded corners, etc.)
4. Produce the presentation using the template

##### Style transfer
1. Analyze the reference file's visual style (color scheme, font style, element characteristics, layout characteristics, content density, etc.), page layouts, content structures, reusable components (icons, shapes, smartart, reusable body layout schemes, etc.), and element styles (e.g., whitespace/line/card separators, square/rounded corners, etc.).
- If the user provides a style reference URL, do not only read the text content; refer to and learn from the page's visual effect more to help understand the style
2. Produce the presentation using the reference file's style characteristics. You are encouraged to reuse illustrations, fonts, font-size hierarchies, elements, etc. from the original pdf/url

### step4. PPT validation
1. Use `../../bin/kimi-slides check --level auto` to validate and repair the generated PPTD directory over multiple rounds
2. Use `../../bin/kimi-slides screenshot` to take screenshots,
  - After screenshotting, first stitch and compress the single-page screenshots for a quick overview
  - Refine problematic pages and run multiple rounds of validation and repair

Note: the current screenshot CLI may have bugs where the result differs from actual rendering. Known issues:
1. Icons degrade into circles
2. Gradient text may degrade into a solid color
These issues exist only in the screenshot CLI and do not affect the validated PPTD deliverable; they can be ignored after confirming the source PPTD is correct.

### step5. PPT delivery
Save the complete validated `.pptd` directory and the rendered screenshot preview directory as normal files in the user's workspace. The final deliverable in kimi-code is the PPTD project directory after `../../bin/kimi-slides check --level auto`, plus screenshots from `../../bin/kimi-slides screenshot` for preview. Exporting `.pptd` to `.pptx` is not available in this environment; if the user needs `.pptx`, tell them the `.pptd` can be opened and exported in the Kimi web editor outside kimi-code.
