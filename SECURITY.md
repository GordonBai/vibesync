# Security Policy

## Supported Versions

Security fixes are provided for the latest public release of VibeSync.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | Best effort |

## Reporting A Vulnerability

Please do not disclose security vulnerabilities publicly before maintainers have had time to investigate.

If the project lists a private security contact on GitHub, use that channel. Otherwise, open a GitHub issue with a short, non-sensitive description such as "Security report contact request" and wait for a maintainer to provide a private reporting path.

Include the following when reporting privately:

- Affected VibeSync version or commit
- Operating system version
- Steps to reproduce
- Expected and actual impact
- Whether local files, transcripts, clipboard data, or localhost API access are involved
- Any proof-of-concept details needed to validate the issue

## Security Model

VibeSync is designed as a local desktop utility.

- The backend binds to `127.0.0.1`.
- The backend reads local coding-agent transcript files from the current user's home directory.
- Takeover prompts may include local paths, agent names, session ids, branch names, and git status snippets.
- The global hotkey writes to the macOS clipboard only after VibeSync resolves a supported agent and matching workspace.
- If context resolution is ambiguous or unsupported, VibeSync should fail closed and leave the clipboard unchanged.

## Out Of Scope

The following are generally outside the security scope unless they expose a vulnerability in VibeSync itself:

- A coding agent storing sensitive content in its own local transcript files
- A user pasting takeover prompts into an untrusted third-party service
- Another local process with the same user permissions reading files or clipboard contents
- macOS permissions granted explicitly by the user to unrelated applications

## Hardening Recommendations

- Download VibeSync only from official project releases.
- Keep macOS and supported coding-agent tools up to date.
- Review takeover prompts before pasting them into remote services.
- Avoid running untrusted local software that can access your clipboard or home directory.
- Use separate macOS user accounts for highly sensitive client work when practical.

## Disclosure Process

Maintainers will aim to:

1. Acknowledge private reports within 7 days.
2. Confirm the affected versions and impact.
3. Prepare and release a fix when appropriate.
4. Credit the reporter unless they request anonymity.
