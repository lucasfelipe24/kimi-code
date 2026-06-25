Search the web for information. Use this when you need up-to-date information from the internet.

Each result includes its title, URL, snippet, and—when available—a publication date. When `include_content` is enabled, the full page content—when available—is appended after the snippet.

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites via `allowed_domains` and `blocked_domains`
  - Use `include_content` sparingly — it can consume a large amount of tokens
