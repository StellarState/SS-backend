# Critical API load profiles

These profiles use [k6](https://k6.io/) and are intentionally kept outside the
application runtime. Set `BASE_URL` to a disposable environment and provide a
test user's bearer token before running them; the profile never contains real
credentials.

```sh
BASE_URL=http://localhost:3000 AUTH_TOKEN=... k6 run load-tests/critical-api.js
```

The default stages exercise the health check, authenticated invoice listing,
referral-tier reads, and invoice publish preflight at a small smoke-load level.
Override `VUS`, `DURATION`, or `LOAD_PROFILE` in k6 when a larger test is needed.
