import { EmailMessage } from 'cloudflare:email'
import { createMimeMessage } from 'mimetext/browser'
import validator from 'validator'

interface Env {
  CONTACT_INBOX: { send: (msg: EmailMessage) => Promise<void> }
  RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
  /** Sender address. Must be on a domain verified in Cloudflare Email Routing. */
  SENDER_ADDRESS: string
  /** Where submissions are delivered. Must match the send_email binding's destination. */
  RECIPIENT_ADDRESS: string
  /** Comma-separated origins allowed to post here, e.g. "https://jacksonwearn.com". */
  ALLOWED_ORIGINS: string
}

const PATH = '/form-submit'

/**
 * The rate limiter keys on the client IP, not the path.
 *
 * Keying on the path meant one shared bucket for every visitor, so a single
 * sender could exhaust the quota and every genuine submission after that got a
 * 429. CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by
 * the client. If it were ever absent the fallback is a shared bucket, which
 * degrades to the old behaviour rather than to no limit at all.
 */
function rateLimitKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const allowed = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const origin = request.headers.get('Origin')

  // Same-origin form posts from the site itself do not always carry an Origin
  // header. Absent is allowed; present and unrecognised is not.
  if (!origin) return true
  return allowed.includes(origin)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname !== PATH) {
      return new Response('Not found', { status: 404 })
    }

    if (!isAllowedOrigin(request, env)) {
      return new Response('Forbidden', { status: 403 })
    }

    const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey(request) })

    if (!success) {
      return new Response(`429 Failure – rate limit exceeded for ${pathname}`, { status: 429 })
    }

    return await submitHandler(request, env)
  },
}

export interface FormData {
  name: string
  email: string
  message: string
}

async function submitHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'POST') {
    try {
      const contentType = request.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        return new Response('Invalid content type', { status: 400 })
      }

      const data = (await request.json()) as FormData

      const name = validator.escape(data.name.trim())
      const email = validator.normalizeEmail(data.email.trim()) || ''
      const message = validator.escape(data.message.trim())

      if (!name || !email || !message) {
        return new Response('Missing required fields', { status: 400 })
      }

      if (!validator.isEmail(email)) {
        return new Response('Invalid email address', { status: 400 })
      }

      const msg = createMimeMessage()
      msg.setSender({ name: 'jacksonwearn.com', addr: env.SENDER_ADDRESS })
      msg.setRecipient(env.RECIPIENT_ADDRESS)
      msg.setSubject('Jackson Wearn Form Submission')
      msg.addMessage({
        contentType: 'text/plain',
        data: `Contact Form Submission\n\nName: ${name}\nEmail: ${email}\nMessage: ${message}`,
      })

      const emailMessage = new EmailMessage(env.SENDER_ADDRESS, env.RECIPIENT_ADDRESS, msg.asRaw())

      try {
        await env.CONTACT_INBOX.send(emailMessage)
        return new Response('Email sent successfully!')
      } catch (e) {
        return new Response((e as Error).message, { status: 500 })
      }
    } catch {
      return new Response('Error processing request', { status: 400 })
    }
  }

  return new Response('Only POST requests are supported', { status: 405 })
}
