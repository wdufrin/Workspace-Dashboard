/**
 * Runtime defaults sourced from Vite build-time env (`VITE_*`).
 *
 * Kept in a tiny dedicated module so the test suite can mock it per-test (Vitest's `vi.stubEnv` does not
 * propagate into other modules' `import.meta.env`), and so production code has a single place that decides
 * what "no project configured" means.
 */
export function getDefaultGcpProjectId(): string {
  const env = (import.meta as unknown as { env?: { VITE_DEFAULT_GCP_PROJECT?: string } }).env;
  // Empty string = Admin Console Only mode (no GCP project; BigQuery & Looker Studio hidden)
  return (env?.VITE_DEFAULT_GCP_PROJECT || '').trim();
}
