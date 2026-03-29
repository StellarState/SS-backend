# Security Policy

## Reporting a vulnerability

Please do not open public GitHub issues for security problems.

- Email the maintainers with the issue summary, affected area, reproduction steps,
  and any suggested mitigation.
- Include whether the report affects authentication, payments, Soroban escrow
  orchestration, or database integrity.
- If you need an acknowledgement, include a preferred contact address in the report.

## Operational checklist

- Configure `CORS_ALLOWED_ORIGINS` explicitly in production.
- Enable `TRUST_PROXY` only behind a trusted reverse proxy.
- Keep `HTTP_BODY_SIZE_LIMIT` small unless a route has a documented reason to exceed it.
- Store private keys only in environment variables; never commit them to the repository.
