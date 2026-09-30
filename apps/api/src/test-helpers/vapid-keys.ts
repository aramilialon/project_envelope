/**
 * A fixed, throwaway VAPID key pair (#39/#40) for tests that only need the server to start
 * with `PushConfig` present, never to reach a real push service: generated once with
 * `web-push generate-vapid-keys` and hardcoded, the same "fixed test constant" convention as
 * test-helpers/app-role.ts's APP_ROLE_PASSWORD.
 */
export const TEST_VAPID_SUBJECT = "mailto:test@example.com";
export const TEST_VAPID_PUBLIC_KEY = "BByh4viL_rqdO__eDaMnj7JUxzCgfBsOdRtpHidFzLCrPJu3kKvtqajrt-QgTvCqBVhyKRaoqLHY_NEdXlYv_Z0";
export const TEST_VAPID_PRIVATE_KEY = "Yt1a4Q7sopE60RYrN0zyJ81yWNLjFWskaGtkoTd4O4g";
