import { authenticate } from "./auth";
import { CHECK_CRON, runCycle } from "./cycle";
import { errorResponse, HttpError } from "./http";
import {
  bulkAction,
  checkNow,
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  setMonitorMaintenance,
  updateMonitor,
} from "./monitors";
import { emailConfigured } from "./notifications";
import { REPORT_CRON, reportHour, reportWindowOpen, runWeeklyReport } from "./report";
import { getTimeZone, setTimeZone } from "./time";

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { method } = request;
  const path = url.pathname;

  if (path === "/api/me" && method === "GET") {
    return Response.json({
      timeZone: getTimeZone(),
      notifications: { email: emailConfigured(env), ntfy: Boolean(env.NTFY_URL && env.NTFY_TOPIC) },
    });
  }
  if (path === "/api/monitors") {
    if (method === "GET") return Response.json(await listMonitors(env));
    if (method === "POST") return Response.json(await createMonitor(env, request), { status: 201 });
    throw new HttpError(405, "Method not allowed");
  }
  if (path === "/api/monitors/bulk") {
    if (method === "POST") return Response.json(await bulkAction(env, request));
    throw new HttpError(405, "Method not allowed");
  }

  const match = /^\/api\/monitors\/(\d+)(\/check|\/maintenance)?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    switch (`${method} ${match[2] ?? ""}`) {
      case "GET ":
        return Response.json(await getMonitor(env, id));
      case "PATCH ":
        return Response.json(await updateMonitor(env, id, request));
      case "DELETE ":
        await deleteMonitor(env, id, url);
        return new Response(null, { status: 204 });
      case "POST /check":
        return Response.json(await checkNow(env, id));
      case "PUT /maintenance":
        return Response.json(await setMonitorMaintenance(env, id, request));
    }
    throw new HttpError(405, "Method not allowed");
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    setTimeZone(env.TIME_ZONE);
    // Assets run behind the Worker (run_worker_first), so the dashboard itself is authenticated too.
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message, err.details);
      console.error("Unhandled API error:", err);
      return errorResponse(500, "Internal error");
    }
  },

  async scheduled(controller, env): Promise<void> {
    setTimeZone(env.TIME_ZONE);
    if (controller.cron === CHECK_CRON) await runCycle(env);
    else if (controller.cron === REPORT_CRON) {
      const now = Date.now();
      if (reportWindowOpen(now, reportHour(env))) await runWeeklyReport(env, now);
    }
    else console.warn(`Unknown cron trigger: ${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;
