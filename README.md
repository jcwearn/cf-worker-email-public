# cf-worker-email

The Cloudflare Worker behind the contact form on [jacksonwearn.com](https://jacksonwearn.com).

> **This is a read-only published snapshot.** Development happens in a private
> repo; a CI job mirrors the filtered tree here on every merge. Issues and pull
> requests opened here won't sync back upstream, and commits here will be
> overwritten by the next sync. Feel free to read, fork, and steal ideas.

One route, `POST /form-submit`. It rate-limits per client IP, checks the request came from an allowed
origin, validates and sanitises the payload, and delivers it as mail through Cloudflare Email Routing.
There is no database and no state.

## Request

```http
POST /form-submit
Content-Type: application/json

{ "name": "...", "email": "...", "message": "..." }
```

| Response | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `200`    | Sent                                                              |
| `400`    | Not JSON, a field is missing, or the email address does not parse |
| `403`    | `Origin` header present and not in `ALLOWED_ORIGINS`              |
| `404`    | Any path other than `/form-submit`                                |
| `405`    | Not a POST                                                        |
| `429`    | Rate limit exceeded for this IP                                   |
| `500`    | Email Routing rejected the send                                   |

## Configuration

Bindings and vars live in `wrangler.jsonc`:

- `CONTACT_INBOX` — the `send_email` binding, restricted to one verified destination
- `RATE_LIMITER` — 50 requests per 60 seconds, keyed per client IP
- `ALLOWED_ORIGINS` — comma-separated list; public information, so it is a plain var

The sender and recipient addresses are secrets rather than vars, which is what lets this repo be
published at all:

```sh
wrangler secret put SENDER_ADDRESS
wrangler secret put RECIPIENT_ADDRESS
```

## Two things worth stealing

**Rate limit per client, not per route.** This Worker originally keyed its limiter on the request
path — a constant, so every visitor shared one bucket and a single sender could exhaust the quota for
everyone. `CF-Connecting-IP` is set by Cloudflare's edge and cannot be spoofed by the client.

**A missing `Origin` header is allowed; a wrong one is not.** Same-origin form posts do not always
send the header. This is a courtesy against casual reuse rather than a security boundary — anything
can set an `Origin` — and the rate limit is what actually protects the endpoint.

## License

MIT. See [LICENSE](LICENSE).
