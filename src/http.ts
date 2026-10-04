// Small HTTP helpers shared by the API handlers.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorResponse(status: number, message: string, details?: Record<string, unknown>): Response {
  return Response.json({ error: message, ...details }, { status });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
