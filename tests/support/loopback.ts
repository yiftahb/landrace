/**
 * `describe` for tests that start a server on 127.0.0.1, and `describe.skip`
 * where that cannot be bound — a write step's OS sandbox forbids it, so an
 * agent cannot reach the board's write routes or any local service.
 * jest.config.mjs probes once, sets LANDRACE_NO_LOOPBACK, and says so; a
 * skipped block there is expected, a failing one never is.
 */
export const describeLoopback: jest.Describe = process.env.LANDRACE_NO_LOOPBACK === "1" ? describe.skip : describe;
