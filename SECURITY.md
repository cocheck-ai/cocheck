# Security policy

## Reporting a vulnerability

Please report a security problem privately, through GitHub private vulnerability reporting: open https://github.com/cocheck-ai/cocheck/security/advisories/new (the "Report a vulnerability" button on the repository's Security tab). Do not open a public issue or pull request for it.

Say what you found, the steps to reproduce it, which CoCheck version it affects (`cocheck --version`), and what an attacker gains. A report is read by the maintainer, who will reply there.

## What counts

CoCheck keeps a local record of what an AI agent changed in your files. Problems of interest include: a way to read or alter the record or the stored file copies without the key, a secret in a format the gitleaks rules detect that reaches the review page or a log without being replaced by a withheld marker (a password in plain prose with no vendor format is not detected, by design; see [docs/security.md](docs/security.md)), a hook that runs or writes outside the folders you registered, and an installer change to your agent settings that CoCheck does not report.

How stored copies are encrypted is described in [docs/security.md](docs/security.md).

## Supported versions

CoCheck is early software. Only the latest release gets fixes.
