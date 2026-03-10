# /human-browser — Claude Code Command

A Claude Code command (skill) that lets Claude Code agents operate your **already-logged-in Chrome** via the human-browser daemon and extension.

Unlike `/chrome-cdp`, this does **not** restart Chrome. It connects to the always-running daemon — so your sessions, cookies, and login state are always preserved.

Place this file at `~/.claude/commands/human-browser.md` to use it as a `/human-browser` slash command in Claude Code.

---

## Profile configuration

Define your profiles in `~/.human-browser/config.<profile>.json` (see `docs/profiles.example.json`).

| Profile | Config path | Port | When to use |
|---------|-------------|------|-------------|
| personal | `~/.human-browser/config.personal.json` | 18765 | Personal URLs (gmail, youtube, x.com, …) |
| work | `~/.human-browser/config.work.json` | 18766 | Company/workspace URLs |

Tokens are stored in the config file — never hard-code them here.

## Step 1: Select profile

Infer the profile from the task context:
- Company / workspace URLs → `work`
- Everything else → `personal`

Set `<CONFIG>` = selected config path, `<PORT>` = corresponding port.

## Step 2: Check daemon health

```bash
curl -s http://127.0.0.1:<PORT>/health
```

- `"ok":true` → proceed to Step 3
- Connection refused → restart the daemon:

```bash
launchctl kickstart -k "gui/$(id -u)/com.teramotodaiki.human-browser.<PROFILE>"
sleep 2
curl -s http://127.0.0.1:<PORT>/health
```

If still failing, report to the user and stop.

## Step 3: Check extension connection

```bash
node ~/.human-browser/src/cli/human-browser.ts --config <CONFIG> status --json
```

- `extension.connected: true` → proceed to Step 4
- `false` → prompt the user:

```
Chrome extension is not connected to the daemon.
Please open the extension Popup and click "Reconnect" (or re-save the config).
```

Wait briefly, then re-check.

## Step 3.5: Multi-tab safety protocol (required before fill/click)

When multiple tabs are open, always identify and activate the correct tab before interacting.

```bash
# 1. List open tabs
TABS=$(... tabs --json)
echo $TABS | python3 -c "import sys,json; [print(t['id'], t['url'][:60]) for t in json.load(sys.stdin)['tabs']]"

# 2. Activate the target tab
... use <tab_id>

# 3. Now safe to fill/click
... fill "input" "value"
```

### open vs navigate vs use

| Command | Behavior | When to use |
|---------|----------|-------------|
| `open <URL>` | Always opens a new tab | First access, or want a separate tab |
| `navigate <URL>` | Changes URL in the active tab | Navigate within an existing tab |
| `use <tab_id>` | Switches which tab is active | Target a specific tab for interaction |

**Anti-pattern**: calling `fill` immediately after `open` — the active tab may have changed.

```bash
# Correct: reuse an existing tab
... use 356231409
... navigate "https://example.com/settings"
... fill "input[name=email]" "user@example.com"
```

## Step 4: Execute the task

Prefix every command with `node ~/.human-browser/src/cli/human-browser.ts --config <CONFIG>`.

### Common commands

```bash
# List tabs
... tabs --json

# Switch active tab
... use <tab_id>

# Open URL in a new tab
... open <URL>

# Navigate active tab to URL
... navigate <URL>

# Get full page structure (start here to understand the page)
... snapshot --json

# Get only interactive elements
... snapshot --interactive --json

# Take a screenshot
... screenshot /tmp/hb-screen.png

# Get text from a selector
... get text '<selector>'

# Get full HTML
... get html

# Click an element
... click '<selector>'

# Type into an element
... fill '<selector>' '<value>'

# Send a key
... keypress Enter

# Wait for element / text / load
... wait '<selector>'
... wait --text '<text>'
... wait --load networkidle

# Run JavaScript
... eval '<js expression>'
```

### Using snapshot refs (@eN)

`snapshot` assigns short refs (`e1`, `e2`, …) to elements. Use them instead of CSS selectors (requires `--snapshot <snapshot_id>`):

```bash
SNAP=$(... snapshot --json)
SNAP_ID=$(echo $SNAP | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['snapshot_id'])")
... click @e3 --snapshot $SNAP_ID
```

## Error handling

| Error code | Meaning | Fix |
|------------|---------|-----|
| `DISCONNECTED` | Extension offline | Ask user to click Reconnect in the extension popup |
| `STALE_SNAPSHOT` | Snapshot outdated | Re-fetch `snapshot` and retry |
| `NO_SUCH_REF` | ref (@eN) not found | Re-fetch `snapshot` |
| `TIMEOUT` | Extension timed out | Retry with `--timeout 30000` |
| `SCRIPT_EXCEPTION` | CSP blocks eval | See CSP section below |

### CSP-restricted domains

Some sites (e.g. `app.slack.com`) block `eval` via Content Security Policy.

| Domain | Restriction | Workaround |
|--------|-------------|-----------|
| `app.slack.com` | `document` access blocked | Use `api.slack.com/apps/…` equivalent pages |

**Pattern**: if `eval` raises `SCRIPT_EXCEPTION`, try `... eval "window.location.href"` to confirm the page, then switch to a CSP-friendly equivalent.

## Tips

- Google pages load slowly — prefer `wait --text <visible string>` over `wait --load networkidle`
- File uploads: `... upload '<selector>' /path/to/file`
- Always run `tabs` first when multiple tabs are open, then `use <tab_id>` before interacting

### React/complex dropdown pattern

When `eval` is blocked by CSP, fall back to keyboard navigation:

```bash
# 1. Open dropdown
... eval "document.querySelector('button[aria-label=\"Add event\"]').click();"

# 2. Type to filter
... fill "input[placeholder*='event']" "message.im"

# 3. Click the matching leaf element
... eval "Array.from(document.querySelectorAll('*')).filter(el=>el.childElementCount===0 && el.textContent.trim()==='message.im')[0]?.click();"

# 4. Fallback if eval fails
... keypress ArrowDown
... keypress Enter
```
