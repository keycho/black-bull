// vite client env vars (only VITE_-prefixed vars reach the browser bundle)
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_MINT_SERVICE_URL?: string; // railway minting service (onchain land)
  readonly VITE_LAND_COLLECTION_URL?: string; // magic eden / tensor collection link
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
