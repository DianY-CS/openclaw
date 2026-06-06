# Telegram MTProto User Driver

This runbook documents the local Telegram user-driver used for OpenClaw + Qwen
Telegram E2E testing on Windows.

The driver logs in as a real Telegram user account through MTProto and sends
messages to the existing OpenClaw Telegram bot. It does not create or register a
new Telegram bot.

## Files

- Driver: `scripts/e2e/telegram-mtproto-driver.mjs`
- Example config: `scripts/e2e/telegram-mtproto-driver.config.example.json`
- Runner integration: `scripts/qwen-telegram-e2e-runner.mjs --driver-kind mtproto`
- Local private state: `scripts/e2e/telegram-mtproto-driver/`

Never commit the local private state directory. It contains `config.local.json`
and `session.txt`.

## Telegram API app

Create a Telegram API app at `https://my.telegram.org` under **API development
tools**. This gives the local MTProto client an `api_id` and `api_hash`.

This is not a bot registration. Continue using the existing OpenClaw bot.

Conservative field values:

```text
App title: Clawdriver
Short name: clawdriver
URL: https://example.com
Platform: Desktop
Description: Local testing client.
```

If Telegram rejects the app name, use a short ASCII-only title without spaces or
punctuation. Avoid using the word `Telegram` in the app title.

## Local config

Create the private config from the example:

```powershell
cd C:\Users\chest\projects\openclaw
New-Item -ItemType Directory -Force scripts\e2e\telegram-mtproto-driver
copy scripts\e2e\telegram-mtproto-driver.config.example.json scripts\e2e\telegram-mtproto-driver\config.local.json
notepad scripts\e2e\telegram-mtproto-driver\config.local.json
```

Fill in local values:

```json
{
  "apiId": 123456,
  "apiHash": "replace-with-my-telegram-org-api-hash",
  "phoneNumber": "+15551234567",
  "defaultChat": "@OpenClawBot",
  "sutUsername": "OpenClawBot",
  "sessionFile": "session.txt"
}
```

`sessionFile` can stay as `session.txt`. The driver writes it under the private
state directory after login.

## Commands

Run doctor:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs doctor --json
```

Log in:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs login --json
```

Enter the Telegram login code in the terminal. If the account has 2FA enabled,
enter the 2FA password when prompted.

Send a small smoke message:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs send --text /new --json
node scripts\e2e\telegram-mtproto-driver.mjs wait --after-message-id <sent-message-id> --timeout-ms 60000 --json
```

Select the local Qwen model:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs send --text "/model llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf" --json
```

Run the Qwen Telegram E2E runner with the MTProto driver:

```powershell
node scripts\qwen-telegram-e2e-runner.mjs --driver-kind mtproto --runs 5
```

Useful runner options:

```text
--skip-new
--skip-model
--task-timeout-ms 900000
--timeout-ms 120000
--output .artifacts\qwen-telegram-mtproto-5run\report.json
```

## Transcript and media checks

Read recent messages:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs transcript --since <message-id-or-run-id> --limit 20 --json
```

Wait for a media message:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs wait --after-message-id <message-id> --media --timeout-ms 120000 --json
```

Wait specifically for a video:

```powershell
node scripts\e2e\telegram-mtproto-driver.mjs wait --after-message-id <message-id> --video --timeout-ms 120000 --json
```

## Expected result

A successful Godot recording run should receive:

- A Telegram video message with text similar to `Here is the 15-second Godot
  gameplay recording.`
- A final JSON/text reply containing `recording.mp4`
- A runner report with `status: "pass"`

## Security notes

The following are local-only and must remain ignored:

```text
scripts/e2e/telegram-mtproto-driver/
scripts/e2e/telegram-mtproto-driver.local.json
scripts/e2e/telegram-mtproto-session*.txt
scripts/user-driver/config.local.json
```

Do not paste `api_hash`, login codes, 2FA passwords, phone numbers, or session
strings into chat logs, issues, commits, or CI output.
