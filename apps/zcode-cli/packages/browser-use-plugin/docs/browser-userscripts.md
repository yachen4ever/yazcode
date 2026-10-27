# IAB user scripts (list / reload / setEnabled)

Observe and manage the built-in browser's userscripts (`~/.yazcode/userscripts/*.user.js`, injected per `@match` by the app runtime). This surface is IAB-only and **trust-gated**: discovery is not enablement, and content is pinned by the sha256 recorded at approval time.

## API (browser-level)

- `await browser.userscripts.list()` → `BrowserUserscriptStatusItem[]`: `{ scriptId, name, version?, runAt, grants, match, status, sha256, detail? }`. `status` ∈ `serving | enabled_pending_anchor | hash_mismatch | disabled | pending_approval | parse_failed | grant_rejected`. No script code and no file paths are returned.
- `await browser.userscripts.reload()` → same list after an immediate rescan (idempotent; there is no cache). Useful right after the user edits script files.
- `await browser.userscripts.setEnabled(scriptId, enabled)` → `{ scriptId, changed, status }` where `status` is the **full status object** of that script after the action — same shape as `list()` items (`{ scriptId, name, version?, runAt, grants, match, status, sha256, detail? }` with `status ∈ serving | enabled_pending_anchor | hash_mismatch | disabled | pending_approval | parse_failed | grant_rejected`), not a bare string. Read `status.status` for the state enum and `status.sha256` for the anchored hash (present once the script has been scanned).

## Confirmation-flow red line (must-read)

`setEnabled(scriptId, true)` **never enables a script by itself**. It records a *pending approval* and returns `pending_approval`; the script stays inert until the user approves it in the app's settings (Browser → User scripts). This is by design: an agent must never cause new, unconfirmed script content to run.

- `setEnabled(scriptId, false)` is allowed and immediate — disabling is de-escalation.
- If the script is already approved (`serving` / `enabled_pending_anchor`), `setEnabled(scriptId, true)` is an idempotent no-op (`changed: false`).
- `hash_mismatch` means the file changed after approval; the script is inert until the user re-approves it. Do not try to "fix" this from the agent side — tell the user instead.

## Typical workflow

```text
1. const browser = await agent.browsers.getDefault()
2. const scripts = await browser.userscripts.list()
   // inspect status/match; report parse_failed / grant_rejected / hash_mismatch to the user
3. To propose enabling a useful script:
   await browser.userscripts.setEnabled("portal-cleaner", true)
   // → pending_approval; ask the user to approve it in Settings → Browser → User scripts
4. After the user approves (or edits files):
   await browser.userscripts.reload()   // fresh facts, anchoring happens on scan
```
