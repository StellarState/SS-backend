# JWT signing-key rotation

Login tokens are HS256 JWTs. Each token's header carries a `kid` (key id)
naming the key that signed it, and each token carries a `jti` that maps to a
row in `wallet_sessions`. Rotation lets the signing key change without signing
out active users.

## Environment

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Current signing secret (required). |
| `JWT_KEY_ID` | Id of the current key. Defaults to `v1`. |
| `JWT_PREVIOUS_SECRET` | Outgoing secret, still accepted for verification during overlap. |
| `JWT_PREVIOUS_KEY_ID` | Id of the outgoing key. Defaults to `v1`. Must differ from `JWT_KEY_ID`. |
| `JWT_PREVIOUS_VALID_UNTIL` | ISO-8601 instant when outgoing tokens stop verifying. Required with `JWT_PREVIOUS_SECRET`. |
| `JWT_REVOKED_KEY_IDS` | Comma-separated key ids rejected immediately, even inside the overlap. |

Tokens issued before key ids existed have no `kid`. They are treated as key
`v1`, so the first rotation keeps them valid as long as the outgoing key is `v1`.

## Rotating

1. Set `JWT_PREVIOUS_SECRET` to the current `JWT_SECRET`, `JWT_PREVIOUS_KEY_ID`
   to the current `JWT_KEY_ID` (or `v1` if unset), and
   `JWT_PREVIOUS_VALID_UNTIL` to now plus `JWT_EXPIRES_IN` (default 15 minutes).
2. Set `JWT_SECRET` to the new secret and `JWT_KEY_ID` to a new id (for example `v2`).
3. Deploy. New logins sign with the new key. Existing tokens keep working until
   their previous-key overlap ends.
4. Once `JWT_PREVIOUS_VALID_UNTIL` has passed, remove `JWT_PREVIOUS_*` from the
   environment on the next deploy.

## Emergency revocation

If a key may be compromised, set `JWT_REVOKED_KEY_IDS` to its id. Every token
signed with that key is rejected from the next request, with no overlap.
Users must sign in again.

## Behavior summary

- **Issuer and audience:** unchanged by this rotation scheme. Tokens are not
  checked for `iss` or `aud`.
- **Expiry:** tokens expire at `JWT_EXPIRES_IN` as before.
- **Sessions:** a token whose `jti` has a revoked or expired `wallet_sessions`
  row is rejected on the next request. Tokens without a `jti` (issued before
  session tracking) can only be invalidated by expiry or key revocation.

## Operations

```powershell
npm run jwt:key-status
```

Prints the current key id, the previous key id with its overlap end and whether
it is still active, and the revoked key ids. Secret values are never printed.
