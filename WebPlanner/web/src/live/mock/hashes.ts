// Placeholder result hashes of the mock (16 lower-case hex, config compute.hash.hex_chars). Kept in
// a module without imports so the live entry can name them without pulling in the mock chunk.

/** Stands for the official plan's hash (the server computes the real one: E3 official_hash()). */
export const MOCK_OFFICIAL_HASH = '0ff1c1a10ff1c1a1'

/** Stands for the hash of a custom-crew plan (MOCK_CREW_INPUTS; the server computes the real one). */
export const MOCK_CREW_HASH = 'c4e3c4e3c4e3c4e3'
