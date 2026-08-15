import { defineConfig } from 'vitest/config'

/**
 * Plain vitest with stubbed bindings, deliberately not
 * @cloudflare/vitest-pool-workers.
 *
 * The pool works again -- 0.21.3 peers vitest ^4.1.0 and this repo pins 4.1.10 --
 * but it is not needed here. The Worker's own Env interface is hand-written and
 * structurally minimal ({ send } and { limit }), so a plain object satisfies it,
 * and every behaviour worth testing is control flow and string handling. There
 * is no KV, D1, Durable Object, cache or waitUntil -- nothing where workerd and
 * Node diverge. The one workerd-specific symbol, EmailMessage, is used purely as
 * a three-argument value carrier.
 *
 * Stubs also make the sharp cases cheap: `{ success: false }` is one line, where
 * driving the real miniflare limiter to refuse takes 51 requests.
 *
 * The precedent is borderline/functions/api/*.test.ts, which tests Pages
 * Functions the same way -- node environment, plain-object env, no pool.
 *
 * If the MIME ever needs checking against the real send_email binding, add
 * pool-workers as a SECOND config and a second script rather than replacing
 * this one; borderline's test:layout split is the established pattern.
 *
 * .mts, not .ts: package.json has no `"type": "module"`, so Vite would load a
 * .ts config as CommonJS and warn about the ESM syntax below. The deleted
 * config was .mts for this reason. Adding `"type": "module"` instead is not
 * free -- it changes what `wrangler types` generates into
 * worker-configuration.d.ts, which is why PR #145 left it off.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      'cloudflare:email': new URL('./test-stubs/cloudflare-email.ts', import.meta.url).pathname,
    },
  },
})
