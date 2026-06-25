Fetch content from a URL. For an HTML page the main article text is extracted; for a plain-text or markdown response the full body is returned verbatim. The result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.

Only public `http`/`https` URLs are supported. Requests to private, loopback, or link-local addresses are refused, and responses larger than 10 MiB are rejected.

When `prompt` is provided, the tool extracts only the information relevant to that prompt from the page content. This is useful for large pages where you only need specific data.

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - Results may be summarized if the content is very large
  - Includes a 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL. You should then make a new FetchURL request with the redirect URL.
  - Some commonly-used documentation sites are pre-approved and will not prompt for permission.
