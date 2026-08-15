/**
 * Stub for the `cloudflare:email` module, which only exists inside workerd.
 * Node cannot resolve that specifier and nothing in node_modules provides it,
 * so `vitest.config.ts` aliases it here.
 *
 * This is not only a shim to make the import resolve. Recording the three
 * constructor arguments is what lets the tests assert on the envelope and on
 * the MIME the Worker actually built -- the sanitisation and email-normalisation
 * cases are unreachable without it.
 */
export class EmailMessage {
  readonly from: string
  readonly to: string
  readonly raw: string

  constructor(from: string, to: string, raw: string) {
    this.from = from
    this.to = to
    this.raw = raw
  }
}
