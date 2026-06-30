# Permission justifications (paste into the Chrome Web Store "Privacy" tab)

## Single purpose
Squirl saves the web page or YouTube video the user is currently viewing to their
Google Drive and/or local downloads as a clean Markdown, Text, or PDF file, optionally
including the YouTube subtitles/transcript.

## Per‑permission justification
- activeTab — Access the current tab only when the user triggers a clip (toolbar click,
  context menu, or shortcut), so Squirl can read the content the user chose to save.
- scripting — Inject a small extraction script into the tab the user is clipping to read
  the article content and, on YouTube, the player/caption data needed to build the file.
- contextMenus — Add the right‑click "Clip to Drive" menu entries.
- downloads — Save the generated Markdown/Text/PDF/subtitle file to the user's computer
  when they choose local download.
- storage — Store the user's own settings locally (format, language, Drive folder, etc.).
- identity, identity.email — Authorize uploads to the user's Google Drive via OAuth and
  display which Google account is connected. The token is handled by Chrome/Google.
- notifications — Inform the user when a clip finishes or fails while the popup is closed.
- offscreen — Generate PDF files (with embedded CJK fonts) in an offscreen document,
  keeping the service worker lightweight.
- Host permissions (optional, https://*/* and http://*/*) — Requested at runtime ONLY if
  the user enables the optional "AI Desktop" integration, and used only to send the clip's
  metadata to the self‑hosted backend URL the user enters. Not requested otherwise.
- Content script on <all_urls> — Extraction runs only on the tab the user actively clips;
  it does not collect or transmit data in the background.

## Remote code
No. Squirl does not load or execute remote code. All logic ships in the package.

## Data usage disclosures (check on the dashboard)
- Website content: YES — the content of the page the user explicitly clips is read to build
  the file; it is sent only to the user's own Google Drive and/or their own AI Desktop URL.
- Authentication information: YES — a Google OAuth token to upload to the user's Drive.
- We do NOT collect: location, health, financial, personal communications, web history,
  or personally identifiable information for our own use.
- We do NOT sell or transfer data to third parties.
- Data is used only to provide the single purpose above (not for ads, not for
  creditworthiness/lending).
