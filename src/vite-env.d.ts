// vite client env vars (only VITE_-prefixed vars reach the browser bundle)
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_EARN_CLAIM_URL?: string; // $ansem claim payout service (dormant when unset)
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
