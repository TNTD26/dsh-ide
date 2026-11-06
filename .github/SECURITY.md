# Security

DSH IDE is a local-first plugin, but it is intentionally a high-permission
plugin. Review the code before installing it into a profile that contains
sensitive data.

## Permissions

The plugin can:

- read and write files under the selected workspace;
- start a local PTY terminal;
- start Python/TypeScript language-server subprocesses;
- store an AI provider API key in DeepSeek Harness credentials;
- send selected code context to the configured AI provider when you ask a
  question.

## Secrets

- API keys are written through the DSH credentials service, not browser
  storage.
- The IDE never returns an API key to the browser.
- Do not commit `.env`, credentials, tokens, or screenshots containing secrets.
- If you believe a key was exposed, revoke it at the provider immediately.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials or
allow arbitrary code execution.

Use GitHub's private vulnerability reporting on this repository:

https://github.com/TNTD26/dsh-ide/security/advisories/new

Include the affected version, a minimal reproduction, and the impact. Do not
include live credentials in the report.
