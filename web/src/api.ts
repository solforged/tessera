export interface NotebookInfo {
  id: string;
  path: string;
  created_at: number;
  schema_version: number;
  sqlite_version: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** GET a JSON resource from the local service, surfacing its error message. */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as ErrorEnvelope | null)?.error?.message;
    throw new Error(message ?? `Request failed with status ${response.status}.`);
  }
  return body as T;
}
