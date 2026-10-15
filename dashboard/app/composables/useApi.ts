import { FetchError } from "ofetch";

/** Calls the Worker API and turns its `{ error }` bodies into readable Error messages. */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await $fetch<T>(path, { method: options.method as any, body: options.body as any });
  } catch (err) {
    if (err instanceof FetchError) {
      throw new Error(err.data?.error ?? `Request failed (${err.statusCode ?? "network error"})`);
    }
    throw err;
  }
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
