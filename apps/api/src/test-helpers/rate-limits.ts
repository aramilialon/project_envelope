/**
 * Rate limits far above what any test sends (#566). Every test request comes from 127.0.0.1 and a
 * test file reuses one user for hundreds of requests, so the defaults (300 a minute per address,
 * 120 writes a minute per user) would refuse requests a test needs. `rate-limit.test.ts` is where
 * the limits themselves are tested, with low ones of its own.
 */
export const HIGH_RATE_LIMITS_ENV: Readonly<Record<string, string>> = {
  RATE_LIMIT_IP_MAX: "1000000",
  RATE_LIMIT_USER_MAX: "1000000",
  RATE_LIMIT_USER_WRITE_MAX: "1000000",
  RATE_LIMIT_USER_IMPORT_MAX: "1000000",
};
