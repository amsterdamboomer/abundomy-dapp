/**
 * Portable configuratie (geen Node-API's) — bruikbaar in Node én in de browser-SPA.
 * Node-only opslagpaden staan in `node-paths.mjs`.
 */

/** Economische parameters van 1CoinH (bevestigd). */
export const DECAY_RATE = 0.99995 // per uur
export const INCOME_PER_HOUR = 1 // basisinkomen, 1 munt/uur
export const ZERO_HASH = '0'.repeat(64) // genesis

/**
 * Gedeelde community-sleutel (Fase 4): bekende deelnemers delen één geheim waarmee
 * profielen client-side versleuteld worden vóór publicatie (IPFS is publiek+permanent).
 * In Node uit de omgeving; in de browser de dev-default (later echte distributie).
 */
export const COMMUNITY_SECRET =
  (typeof process !== 'undefined' && process.env?.ABUNDOMY_COMMUNITY_SECRET) ||
  'abundomy-dev-community-secret'
