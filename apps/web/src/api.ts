/**
 * The one thing this skeleton needs to prove (#48): a real connection to `apps/api`. A real
 * screen's own data fetching (React Query, or whatever #53+ settles on) replaces this; for now
 * it only calls `/health`.
 */
const API_URL: string = import.meta.env.VITE_API_URL;

export type HealthStatus = "ok" | "error";

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const response = await fetch(`${API_URL}/health`);
    return response.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}
