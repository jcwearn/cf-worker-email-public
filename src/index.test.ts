import { describe, expect, it, vi } from 'vitest'
import worker from './index'
// Typed against the stub rather than 'cloudflare:email', deliberately. tsc does
// not know about vitest's resolve.alias, so importing the module specifier here
// would resolve to the real @cloudflare/workers-types declaration -- which has
// no `raw` property, because the real EmailMessage does not expose what it was
// constructed with. The stub is what actually runs under test, so it is what
// the assertions should be typed against. src/index.ts still typechecks against
// the real types, which is the half that matters.
import type { EmailMessage } from '../test-stubs/cloudflare-email'

/**
 * Plain vitest against stubbed bindings -- see vitest.config.mts for why this is
 * not @cloudflare/vitest-pool-workers.
 *
 * The Worker's Env is `{ send }` and `{ limit }` plus three strings, so the fake
 * below is the whole of it. `cloudflare:email` is aliased to a stub that records
 * its constructor arguments, which is what makes the MIME assertions possible.
 */

const SENDER = 'form@wearn.dev'
const RECIPIENT = 'contact@wearn.dev'
const ORIGIN = 'https://jacksonwearn.com'

type Sent = EmailMessage

function makeEnv(over: { limit?: boolean; send?: () => Promise<void> } = {}) {
  const sent: Sent[] = []
  const send = vi.fn(async (msg: Sent) => {
    sent.push(msg)
    if (over.send) await over.send()
  })
  const limit = vi.fn(async () => ({ success: over.limit ?? true }))
  return {
    env: {
      CONTACT_INBOX: { send },
      RATE_LIMITER: { limit },
      SENDER_ADDRESS: SENDER,
      RECIPIENT_ADDRESS: RECIPIENT,
      ALLOWED_ORIGINS: `${ORIGIN},https://www.jacksonwearn.com`,
    },
    send,
    limit,
    sent,
  }
}

type Opts = {
  method?: string
  origin?: string | null
  ip?: string | null
  body?: unknown
  ct?: string | null
}

function call(env: ReturnType<typeof makeEnv>['env'], path = '/form-submit', o: Opts = {}) {
  const headers = new Headers()
  if (o.origin !== null) headers.set('Origin', o.origin ?? ORIGIN)
  if (o.ip !== null) headers.set('CF-Connecting-IP', o.ip ?? '203.0.113.5')
  if (o.ct !== null) headers.set('content-type', o.ct ?? 'application/json')

  const init: RequestInit = { method: o.method ?? 'POST', headers }
  if (o.body !== undefined) init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return worker.fetch(new Request(`https://worker.test${path}`, init), env as any)
}

const valid = { name: 'Ada', email: 'ada@example.com', message: 'Hello' }

/**
 * mimetext writes headers as RFC 2047 encoded-words, so the raw MIME carries
 * `Subject: =?utf-8?B?SmFja3Nvbi4uLg==?=` rather than readable text. Decoding
 * keeps the assertions legible instead of comparing base64 blobs -- and records
 * that the encoding happens at all, which is not obvious from the Worker source.
 *
 * The body is a separate matter: it is 7bit text/plain and needs no decoding.
 */
function decodeHeaders(raw: string): string {
  return raw.replace(/=\?utf-8\?B\?([^?]*)\?=/gi, (_, b64) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  )
}

describe('routing and gating', () => {
  it('404s an unknown path without touching either binding', async () => {
    // The early return precedes both, so a probe of / costs no rate-limit quota.
    const { env, send, limit } = makeEnv()
    const res = await call(env, '/')

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not found')
    expect(limit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('403s an unrecognised Origin without consuming rate-limit quota', async () => {
    // The ordering is the point: a rejected origin must not let an attacker
    // exhaust a legitimate visitor's bucket.
    const { env, limit } = makeEnv()
    const res = await call(env, '/form-submit', { origin: 'https://evil.test' })

    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Forbidden')
    expect(limit).not.toHaveBeenCalled()
  })

  it('allows a request with no Origin header at all', async () => {
    // Deliberate and documented: same-origin form posts do not always carry
    // Origin. This is the decision most likely to be "fixed" by a later reader.
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', { origin: null, body: valid })

    expect(res.status).toBe(200)
  })

  it('keys the rate limiter on the client IP', async () => {
    const { env, limit } = makeEnv()
    await call(env, '/form-submit', { ip: '198.51.100.9', body: valid })

    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.9' })
  })

  it('falls back to a shared bucket when CF-Connecting-IP is absent', async () => {
    // Degrades to the old shared-bucket behaviour rather than to no limit.
    const { env, limit } = makeEnv()
    await call(env, '/form-submit', { ip: null, body: valid })

    expect(limit).toHaveBeenCalledWith({ key: 'unknown' })
  })

  it('429s when the limiter refuses', async () => {
    const { env, send } = makeEnv({ limit: false })
    const res = await call(env, '/form-submit', { body: valid })

    expect(res.status).toBe(429)
    expect(await res.text()).toContain('rate limit exceeded')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('request validation', () => {
  it('405s a GET, and the rate limiter has already been consumed', async () => {
    // Method is checked after the limiter, so a GET flood still costs quota.
    // Pinned because it is a plausible thing to reorder without noticing.
    const { env, limit } = makeEnv()
    const res = await call(env, '/form-submit', { method: 'GET', body: undefined })

    expect(res.status).toBe(405)
    expect(await res.text()).toBe('Only POST requests are supported')
    expect(limit).toHaveBeenCalled()
  })

  it('400s a non-JSON content type', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', { ct: 'text/plain', body: 'x' })

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Invalid content type')
  })

  it('accepts application/json with a charset parameter', async () => {
    // The check is `.includes`, so a charset must not break a real browser post.
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', {
      ct: 'application/json; charset=utf-8',
      body: valid,
    })

    expect(res.status).toBe(200)
  })

  it('400s a malformed JSON body', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', { body: '{not json' })

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Error processing request')
  })

  it('reports absent and blank fields differently', async () => {
    // Same status, different message, different code path -- and the asymmetry
    // is invisible from the outside. An absent field throws a TypeError on
    // .trim() and lands in the outer catch; a blank one trims to '' and reaches
    // the explicit check.
    const { env } = makeEnv()

    const absent = await call(env, '/form-submit', { body: {} })
    expect(absent.status).toBe(400)
    expect(await absent.text()).toBe('Error processing request')

    const blank = await call(env, '/form-submit', {
      body: { name: '  ', email: '  ', message: '  ' },
    })
    expect(blank.status).toBe(400)
    expect(await blank.text()).toBe('Missing required fields')
  })
})

describe('sanitisation and email handling', () => {
  it('escapes HTML in the name before it reaches the message', async () => {
    const { env, sent } = makeEnv()
    await call(env, '/form-submit', {
      body: { ...valid, name: '<script>alert(1)</script>' },
    })

    expect(sent[0].raw).toContain('&lt;script&gt;')
    expect(sent[0].raw).not.toContain('<script>')
  })

  it('normalises the email, which changes where replies go', async () => {
    // Foo.Bar+spam@Gmail.com and foobar@gmail.com are the same mailbox, but the
    // normalised form is what gets recorded -- worth pinning deliberately.
    const { env, sent } = makeEnv()
    await call(env, '/form-submit', {
      body: { ...valid, email: 'Foo.Bar+spam@Gmail.com' },
    })

    expect(sent[0].raw).toContain('foobar@gmail.com')
  })

  it('rejects an unparseable email as invalid', async () => {
    // Worth knowing why this reaches isEmail at all. validator.normalizeEmail
    // does NOT return false here -- it returns '@not-an-email', a truthy string
    // -- so the `|| ''` fallback never fires and the empty-field check passes.
    // isEmail is what actually catches it. The same is true of a blank email,
    // which normalises to '@'.
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', { body: { ...valid, email: 'not-an-email' } })

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Invalid email address')
  })

  it('still reports a blank email as missing when other fields are blank too', async () => {
    // Ordering detail: a blank email normalises to the truthy '@', so on its own
    // it would be reported as invalid rather than missing. It is the blank name
    // that triggers the missing-fields message below.
    const { env } = makeEnv()
    const res = await call(env, '/form-submit', { body: { ...valid, email: '   ' } })

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Invalid email address')
  })
})

describe('delivery', () => {
  it('sends one message with the expected envelope and MIME, and returns 200', async () => {
    const { env, send, sent } = makeEnv()
    const res = await call(env, '/form-submit', {
      body: { name: 'Ada', email: 'ada@example.com', message: 'Hello there' },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Email sent successfully!')
    expect(send).toHaveBeenCalledTimes(1)

    // The envelope is separate from the MIME headers, so both are worth checking.
    expect(sent[0].from).toBe(SENDER)
    expect(sent[0].to).toBe(RECIPIENT)

    const mime = decodeHeaders(sent[0].raw)
    expect(mime).toContain('Subject: Jackson Wearn Form Submission')
    expect(mime).toContain('jacksonwearn.com')
    expect(mime).toContain(`<${SENDER}>`)
    expect(mime).toContain(`<${RECIPIENT}>`)
    expect(mime).toContain('Name: Ada')
    expect(mime).toContain('Email: ada@example.com')
    expect(mime).toContain('Message: Hello there')
  })

  it('returns 500 with the internal error message when send fails', async () => {
    // Documents that internal error text reaches the client. If that is later
    // judged wrong, this is the test that records the decision changing.
    const { env } = makeEnv({
      send: async () => {
        throw new Error('destination not verified')
      },
    })
    const res = await call(env, '/form-submit', { body: valid })

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('destination not verified')
  })

  it('sets no CORS headers on any response', async () => {
    // This endpoint is same-origin only -- jackson-wearn posts to it with a
    // relative fetch('/form-submit'). Pinned because adding CORS headers would
    // quietly widen who can submit.
    const { env } = makeEnv()
    const ok = await call(env, '/form-submit', { body: valid })
    const denied = await call(env, '/form-submit', { origin: 'https://evil.test' })

    expect(ok.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
