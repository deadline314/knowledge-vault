# Squirl — Privacy Policy

_Last updated: 2026-06-30_

Squirl is a browser extension that saves web pages and YouTube videos you choose to your
own Google Drive and/or your computer. This policy explains what data Squirl processes.

## What Squirl processes
- **Page content you clip.** When you trigger a clip, Squirl reads the content of that
  page (text, structure, and for YouTube the title, chapters, and subtitles) to build the
  output file. This happens only on the tab you act on, only when you act.
- **Your Google account (optional).** If you enable Google Drive, Squirl uses Google OAuth
  to obtain a token that lets it create files in your Drive, and reads your account email
  to show which account is connected.
- **Your settings.** Format, interface language, Drive folder, and similar preferences are
  stored locally in your browser via `chrome.storage`.

## Where your data goes
- To **your** Google Drive (only the folder you choose), and/or your local Downloads.
- If you enable the optional "AI Desktop" integration, the clip's file/metadata is sent to
  the backend URL **you** provide. You control that server.
- Nowhere else. Squirl has **no developer-operated server** and performs no analytics.

## What Squirl does NOT do
- No tracking, advertising, or behavioral profiling.
- No selling or sharing of your data with third parties.
- No background collection — extraction runs only on a page you actively clip.
- No remote code execution; all code ships inside the extension package.

## Data retention
Squirl stores only your settings, locally, until you change or remove them or uninstall the
extension. Clipped files live in your Drive/computer and are controlled by you. The Google
OAuth token is managed by Chrome/Google and can be revoked at
https://myaccount.google.com/permissions .

## Google API Services / Limited Use
Squirl's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Drive access uses the `drive.file` scope, which
limits Squirl to files it creates.

## Contact
Questions: stanley890314@gmail.com
