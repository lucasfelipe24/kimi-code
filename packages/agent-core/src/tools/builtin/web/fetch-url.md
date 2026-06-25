Fetch content from a URL. For an HTML page the main article text is extracted; for a plain-text or markdown response the full body is returned verbatim. The result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.

Only public `http`/`https` URLs are supported. Requests to private, loopback, or link-local addresses are refused, and responses larger than 10 MiB are rejected.
