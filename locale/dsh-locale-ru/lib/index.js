/**
 * Host half of the Russian language pack.
 *
 * The browser half is the whole feature; this row exists so the Loader has an
 * entry for the package and the client-modules scanner can publish its
 * `dsh.client` bundle.
 */
export const name = 'dsh-locale-ru'

export const inject = []

export function apply() {
  // Nothing to do on the Host.
}
