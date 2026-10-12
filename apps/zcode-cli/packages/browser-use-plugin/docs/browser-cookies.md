# Browser cookies (get / set)

Read or inject the browser session's cookies. Cookies are **session-credential-level data**: the values include login tokens (often httpOnly) — never write them into logs or include them in output for unrelated parties.

## API (browser-level)

- `await browser.cookies.get()` → array of `{ name, value, domain, path, expires, httpOnly, secure, sameSite }` for the whole browser context (IAB partition / the selected external browser).
- `await browser.cookies.set(cookies)` → `{ set, failed }`. Each cookie needs `name` + `value` and either `url` or `domain` + `path`. Writes happen one by one; a rejected entry is reported in `failed` and does not block the rest. httpOnly cookies are writable.

Supported on the `iab` and `cdp` backends. Not available on `extension`.

## Typical workflow: reuse an existing login (session import)

The in-app browser (IAB) starts with a clean session and does not share login state with the user's daily browser. When a target site's login requires a second factor the agent cannot complete (mobile app approval, SMS code), import the cookies from the browser where the session already exists:

```text
1. Select the external browser backend (e.g. a Chromium fork started with
   --remote-debugging-port=9222) via agent.browsers / cdp selection.
2. const cookies = await browser.cookies.get()      // full context, plaintext via CDP
3. Filter to the target site's domains (cookie.domain), then:
   agent.browsers.get("iab") → await browser.cookies.set(filtered)
4. Open the target site in IAB and verify the logged-in state by a page feature
   (e.g. the portal greeting), not just by absence of a redirect.
```

Notes:

- Session validity must be judged by a data API returning JSON — many SPAs keep
  rendering the shell after the session died (see the OA session-expiry symptom:
  data endpoints return ~1.2KB of HTML shell).
- Never automate the login itself when the site requires user-held factors; import
  an existing session or hand off to the user instead.
- Backends: `iab` cookies live in the `persist:zcode-embedded-browser` partition and
  survive restarts; `cdp` cookies live in the external browser's profile.
