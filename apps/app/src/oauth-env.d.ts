import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    /** Injected by OAuthProvider into requests it passes on; absent in queue and cron handlers. */
    OAUTH_PROVIDER?: OAuthHelpers;
  }
}
