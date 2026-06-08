# GPT SSO Loginer

[Chinese README](./README.md)

Batch automation for Codex/OpenAI SSO accounts from `invite.kyl23333.xyz`, then import successful OAuth auth data into local `codex-tools`.

This project uses a real Chrome window through Chrome DevTools Protocol. The first run opens `https://invite.kyl23333.xyz/`; log in there manually and keep the Chrome window open. Later runs reuse the same dedicated Chrome profile.

## What It Does

1. Opens a fresh Codex/OpenAI OAuth URL for each account.
2. Enters the selected email on `auth.openai.com`.
3. Selects the SSO workspace/provider.
4. Opens the external provider entry from `oauth.luminet.cn` or `oauth.kyl23333.xyz`.
5. Reads the account list from `invite.kyl23333.xyz`.
6. Matches the exact current email and clicks the login button in the same row.
7. Handles OpenAI sign-in consent and Codex OAuth consent.
8. Retries the same account with a fresh OAuth URL if OpenAI shows `/add-phone` before Codex consent.
9. Captures the localhost callback and writes the account into `codex-tools`.
10. Skips accounts that are already present in `codex-tools`.

## Requirements

- Windows with Google Chrome installed.
- Node.js 18 or newer.
- `codex-tools` installed and configured locally.
- A logged-in account on `https://invite.kyl23333.xyz/`.

## Setup

```powershell
git clone https://github.com/oldsix686/GPT-SSO-Loginer-for-Codex-Tools.git gpt-sso-loginer
cd gpt-sso-loginer
npm install
Copy-Item .env.example .env
```

Edit `.env` if Chrome is not installed at:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

The defaults are designed for `codex-tools` mode:

```env
TARGET=codex-tools
BROWSER_MODE=cdp
BROWSER_CDP_URL=http://127.0.0.1:9222
SYNC_PLATFORM_EMAILS_BEFORE_LOGIN=true
SKIP_USED_EMAILS=true
TRACK_USED_EMAILS=true
MAX_RETRIES=3
STOP_ON_FAILURE=true
```

## First Run

Start the dedicated real Chrome profile:

```powershell
npm run real-chrome
```

Chrome opens `https://invite.kyl23333.xyz/`. Log in on that page and finish any Cloudflare verification. Keep this Chrome window open.

Then run one account as a live test:

```powershell
npm run login-one
```

If the test succeeds, run the batch:

```powershell
npm run login
```

## Email Source

With `SYNC_PLATFORM_EMAILS_BEFORE_LOGIN=true`, the script reads the currently assigned account emails from the logged-in `invite.kyl23333.xyz` page and writes them to `emails.txt` before each run.

You can also provide emails manually:

```powershell
Copy-Item emails.example.txt emails.txt
```

Use one email per line.

## Important Files

- `emails.txt`: generated or manual account email list.
- `used-emails.txt`: accounts already consumed by this script.
- `artifacts/`: logs, result CSV/JSONL, failure screenshots.
- `profiles/`: dedicated Chrome profile with login cookies.
- `%APPDATA%\com.carry.codex-tools\accounts.json`: default `codex-tools` account store on Windows.

## Do Not Commit Local Data

The `.gitignore` intentionally excludes:

- `.env`
- `emails.txt`
- `emails.txt.*`
- `used-emails.txt`
- `artifacts/`
- `profiles/`
- `accounts.json`
- logs and backups

These files can contain account emails, OAuth callback URLs, browser cookies, and local account tokens.

## Useful Commands

```powershell
npm run real-chrome
npm run sync-platform-emails
npm run login-one
npm run login
```

## Notes

Cloudflare verification is not bypassed. If it appears, finish it manually in the opened Chrome window.

The script only marks an email as used after reaching the Codex authorization consent page or capturing the localhost callback. If OpenAI shows `/add-phone` before that point, it retries the same account with a fresh OAuth URL.
