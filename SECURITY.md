# Security Policy

## Supported versions

Security fixes are provided for the latest released minor version of Montane
Code. Users should reproduce reports against the latest version before filing.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Send a private
security advisory through the repository's GitHub Security tab and include:

- affected version and platform;
- minimal reproduction steps;
- expected and observed security boundary;
- impact assessment;
- any suggested mitigation.

Secrets, credentials, private source code, and customer data must be removed
from reports. The maintainer will acknowledge a valid report, coordinate a fix,
and publish an advisory when affected users can upgrade safely.

## Security boundaries

Montane treats repository content, model output, MCP responses, and fetched
content as untrusted. Host execution is an explicit compatibility mode and does
not provide operating-system isolation. Review permissions and use the Docker
sandbox for untrusted workspaces.
