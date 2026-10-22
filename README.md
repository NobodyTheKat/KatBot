# KatBot

## Features
- `/ping` and `/setup` are retained.
- Configure welcome messages, rotating activities, and custom slash commands from `/setup`.
- Custom command responses support plain text (backward compatible) or an advanced JSON embed.
- Optional startup-only GitHub update check when installed from a Git clone.

## Advanced custom command response
In `/setup` → **Custom Commands** → create/edit a command, paste a JSON object into the response field, for example:

```json
{
  "content": "A message above the embed",
  "embed": {
    "title": "KatBot News",
    "description": "Use **Markdown** here.\nAdd another line.",
    "color": "#5865F2",
    "url": "https://example.com",
    "author": "KatBot",
    "footer": "Community updates",
    "thumbnail": "https://example.com/thumb.png",
    "image": "https://example.com/banner.png",
    "timestamp": true,
    "fields": [
      { "name": "Status", "value": "Online", "inline": true },
      { "name": "Website", "value": "https://example.com", "inline": true }
    ]
  }
}
```

Supported embed keys: `title`, `description`, `color` (hex like `#5865F2` or integer), `url`, `author`, `footer`, `thumbnail`, `image`, `timestamp` (`true` or `false`), and `fields` (up to 25 entries, each with `name`, `value`, optional `inline`). `content` is optional. Plain text responses continue to work. Image URLs must be publicly accessible HTTPS/HTTP URLs. Attachments and interactive components are not yet part of the custom-command editor.

## Startup-only GitHub updates
The updater checks GitHub **once when KatBot starts**, not every 10 minutes. It is enabled by default only in a Git checkout with a configured `origin` remote. It uses `git fetch` and a safe fast-forward merge; if there is no `.git` directory, it skips updating. If `package.json` or `package-lock.json` changes, it runs `npm ci` before restarting with the new code.

### Important
- Keep `.env` private. Never commit it.
- `data/settings.json` is ignored by Git and is never overwritten by the updater.
- Do not commit `data/settings.json`; the bot creates it locally if missing.
- The updater cannot update a project copied from a ZIP because ZIPs do not contain Git history. Install the repository using `git clone` in Termux for updates to work.

### Termux setup (first install from GitHub)
1. Install Git and Node.js: `pkg install git nodejs`
2. Clone your own repository: `git clone https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git KatBot`
3. Enter it: `cd KatBot`
4. Create `.env` locally and add `DISCORD_TOKEN=YOUR_BOT_TOKEN`.
5. Install dependencies: `npm ci`
6. Start the bot: `node index.js`

When you later push code to the selected GitHub branch, the next time you start `node index.js`, KatBot checks for updates and applies a fast-forward update. The repository branch can be set using `GITHUB_BRANCH` in `.env` (defaults to the current checked-out branch).
