/**
 * Small route registry for the official Hive frontend compatibility shell.
 *
 * The official frontend talks to a large `/api` surface. pi_hive only
 * implements a subset. This registry records which official routes exist,
 * which are partially compatible, and which are missing, so the server can
 * answer missing routes with a structured 501 instead of a generic 404.
 *
 * It is deliberately dependency-free and does not import the server.
 */

export const ROUTE_STATUS = Object.freeze({
  IMPLEMENTED: "implemented",
  PARTIAL: "partial",
  MISSING: "missing",
});

const STATUSES = new Set(Object.values(ROUTE_STATUS));
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Structured payload used for every unimplemented route. */
export function notImplementedBody({ method = "GET", route = "/" } = {}) {
  const routePath = typeof route === "string" ? route : route.path || "/";
  return {
    error: `not implemented: ${method} ${routePath}`,
    type: "not_implemented",
    route: routePath,
    method,
  };
}

/**
 * Default handler for routes marked missing. Returns the response descriptor
 * instead of writing to a socket so the registry stays usable in tests and
 * from the plain node:http server.
 */
export function notImplementedHandler({ route } = {}) {
  return {
    status: 501,
    body: notImplementedBody({
      method: route?.method || "GET",
      route: route?.path || "/",
    }),
  };
}

/** Normalize a pathname: leading slash, collapsed slashes, no trailing slash. */
export function normalizePathname(input) {
  const raw = String(input ?? "/").split("?")[0].split("#")[0];
  let pathname = raw.startsWith("/") ? raw : `/${raw}`;
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname || "/";
}

function splitSegments(pathname) {
  return normalizePathname(pathname).split("/").filter(Boolean);
}

function decodeParam(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Keep malformed escapes matchable rather than throwing from a router.
    return segment;
  }
}

/** Score a route by literal segments; used to prefer exact paths over params. */
function specificity(pattern) {
  const segments = splitSegments(pattern);
  let literal = 0;
  for (const segment of segments) if (!segment.startsWith(":")) literal += 1;
  return literal * 1000 + segments.length;
}

export class RouteRegistry {
  constructor() {
    /** @type {Array<{method:string,path:string,handler:Function|null,meta:object}>} */
    this.routes = [];
  }

  /**
   * Register one route. Re-registering the same method+pattern replaces the
   * previous entry, which keeps the default registry idempotent.
   *
   * @param {string} method
   * @param {string} pattern e.g. `/api/colonies/:name/messages`
   * @param {Function|null} handler
   * @param {{status?: string, description?: string}} meta
   */
  register(method, pattern, handler = null, meta = {}) {
    const normalizedMethod = String(method || "").toUpperCase();
    if (!METHODS.has(normalizedMethod)) {
      throw new Error(`unsupported method: ${method}`);
    }
    if (typeof pattern !== "string" || !pattern.startsWith("/")) {
      throw new Error(`route pattern must start with '/': ${pattern}`);
    }
    const normalizedPattern = normalizePathname(pattern);
    const status = meta.status || ROUTE_STATUS.MISSING;
    if (!STATUSES.has(status)) {
      throw new Error(`unsupported route status: ${status}`);
    }
    if (status === ROUTE_STATUS.MISSING && typeof handler !== "function") {
      handler = notImplementedHandler;
    }
    if (handler !== null && typeof handler !== "function") {
      throw new TypeError(`handler for ${normalizedMethod} ${normalizedPattern} must be a function or null`);
    }

    const route = {
      method: normalizedMethod,
      path: normalizedPattern,
      handler,
      status,
      meta: { ...meta, status },
    };
    const existing = this.routes.findIndex(
      (entry) => entry.method === normalizedMethod && entry.path === normalizedPattern,
    );
    if (existing >= 0) this.routes[existing] = route;
    else this.routes.push(route);
    return route;
  }

  /**
   * Drop one route. Used at install time to retire a legacy pattern that
   * collides with an official handler (same shape, different param name).
   * Returns true when an entry was removed.
   */
  remove(method, pattern) {
    const normalizedMethod = String(method || "").toUpperCase();
    const normalizedPattern = normalizePathname(pattern);
    const before = this.routes.length;
    this.routes = this.routes.filter(
      (route) => !(route.method === normalizedMethod && route.path === normalizedPattern),
    );
    return this.routes.length !== before;
  }

  /** Public route list: method, path, status. */
  list() {
    return this.routes.map((route) => ({
      method: route.method,
      path: route.path,
      status: route.status,
    }));
  }

  /** Status totals for `/api/compat/routes`. */
  counts() {
    const counts = {
      implemented: 0,
      partial: 0,
      missing: 0,
      total: this.routes.length,
    };
    for (const route of this.routes) counts[route.status] += 1;
    return counts;
  }

  /**
   * Match method + pathname. Returns `{ route, params, pathname }` or null.
   * Params are decoded individually after matching, so an encoded slash in a
   * value cannot change the shape of the route.
   */
  match(method, pathname) {
    const normalizedMethod = String(method || "").toUpperCase();
    const normalizedPath = normalizePathname(pathname);
    const parts = splitSegments(normalizedPath);

    let best = null;
    let bestScore = -1;
    for (const route of this.routes) {
      // HEAD is served by the GET handler for read-only routes.
      const methodMatches =
        route.method === normalizedMethod ||
        (normalizedMethod === "HEAD" && route.method === "GET");
      if (!methodMatches) continue;

      const patternParts = splitSegments(route.path);
      if (patternParts.length !== parts.length) continue;

      const params = {};
      let matches = true;
      for (let i = 0; i < patternParts.length; i += 1) {
        const patternPart = patternParts[i];
        if (patternPart.startsWith(":")) {
          const name = patternPart.slice(1);
          if (!name) { matches = false; break; }
          params[name] = decodeParam(parts[i]);
        } else if (patternPart !== parts[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      const score = specificity(route.path);
      if (score > bestScore) {
        best = { route, params, pathname: normalizedPath, status: route.status };
        bestScore = score;
      }
    }
    return best;
  }
}

/**
 * Default registry for the compatibility shell. Statuses are about
 * compatibility with the official frontend contract:
 *   implemented - the route exists and serves the real pi_hive data
 *   partial     - the route exists but the official client may expect more
 *   missing     - no implementation; the server returns a structured 501
 */
export function createDefaultRegistry() {
  const registry = new RouteRegistry();
  const IMPLEMENTED = ROUTE_STATUS.IMPLEMENTED;
  const PARTIAL = ROUTE_STATUS.PARTIAL;
  const MISSING = ROUTE_STATUS.MISSING;

  // --- Existing pi_hive API (native contract) ---------------------------
  registry.register("GET", "/api/health", null, {
    status: IMPLEMENTED,
    description: "pi_hive health probe",
  });
  registry.register("GET", "/api/colonies", null, {
    status: PARTIAL,
    description: "lists colonies, but not the official tools-index shape",
  });
  registry.register("POST", "/api/colonies", null, {
    status: PARTIAL,
    description: "native pi_hive colony creation",
  });
  registry.register("GET", "/api/colonies/:name", null, {
    status: PARTIAL,
    description: "colony metadata/plan, not the official detail envelope",
  });
  registry.register("GET", "/api/colonies/:name/messages", null, { status: PARTIAL });
  registry.register("GET", "/api/colonies/:name/tracker", null, { status: IMPLEMENTED });
  registry.register("GET", "/api/colonies/:name/workers", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/workers", null, { status: IMPLEMENTED });
  registry.register("POST", "/api/colonies/:name/chat", null, { status: PARTIAL });
  registry.register("GET", "/api/colonies/:name/events", null, {
    status: PARTIAL,
    description: "native colony SSE channel",
  });
  registry.register("GET", "/api/colonies/:name/soul", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/soul/review", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/soul/mode", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/soul/apply", null, { status: PARTIAL });
  registry.register("GET", "/api/colonies/:name/inbox", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/sentinel/reply", null, { status: PARTIAL });
  registry.register("POST", "/api/colonies/:name/playbooks/stop", null, { status: IMPLEMENTED });
  registry.register("POST", "/api/colonies/:name/playbooks/run", null, { status: IMPLEMENTED });
  registry.register("GET", "/api/colonies/:name/playbooks/runs", null, { status: IMPLEMENTED });
  registry.register("GET", "/api/colonies/:name/triggers", null, { status: IMPLEMENTED });
  registry.register("POST", "/api/colonies/:name/triggers", null, { status: IMPLEMENTED });
  registry.register("POST", "/api/colonies/:name/triggers/:trigger/webhook", null, {
    status: IMPLEMENTED,
  });

  // --- Official frontend critical boot routes ---------------------------
  registry.register("GET", "/api/config/features", null, { status: MISSING });
  registry.register("PUT", "/api/config/features", null, { status: MISSING });
  registry.register("GET", "/api/config/llm", null, { status: MISSING });
  registry.register("PUT", "/api/config/llm", null, { status: MISSING });
  registry.register("GET", "/api/config/llm-sections", null, { status: MISSING });
  registry.register("PUT", "/api/config/llm-sections", null, { status: MISSING });
  registry.register("GET", "/api/startup-status", null, { status: MISSING });

  registry.register("GET", "/api/colonies/tools-index", null, { status: MISSING });
  registry.register("GET", "/api/colonies/:name/sessions", null, { status: MISSING });
  registry.register("GET", "/api/colonies/:name/active-session", null, { status: MISSING });
  registry.register("POST", "/api/colonies/:name/scaffold", null, { status: MISSING });
  registry.register("POST", "/api/colonies/:name/rename", null, { status: MISSING });
  registry.register("POST", "/api/colonies/:name/reveal", null, { status: MISSING });
  registry.register("DELETE", "/api/colonies/:name", null, { status: MISSING });

  registry.register("GET", "/api/sessions", null, { status: MISSING });
  registry.register("POST", "/api/sessions", null, { status: MISSING });
  registry.register("GET", "/api/sessions/history", null, { status: MISSING });
  registry.register("GET", "/api/sessions/:id", null, { status: MISSING });
  registry.register("POST", "/api/sessions/:id/chat", null, { status: MISSING });
  registry.register("GET", "/api/sessions/:id/events/history", null, { status: MISSING });

  registry.register("GET", "/api/queen/profiles", null, { status: MISSING });
  registry.register("POST", "/api/queen/create", null, { status: MISSING });
  registry.register("GET", "/api/queen/removed", null, { status: MISSING });
  registry.register("GET", "/api/queen/:id/overview", null, { status: MISSING });
  registry.register("GET", "/api/queen/:id/soul", null, { status: MISSING });

  registry.register("GET", "/api/models/overview", null, { status: MISSING });
  registry.register("GET", "/api/credentials", null, { status: MISSING });
  registry.register("POST", "/api/credentials", null, { status: MISSING });
  registry.register("GET", "/api/memories", null, { status: MISSING });

  return registry;
}

/** Shared default registry used by the server and `/api/compat/routes`. */
export const defaultRegistry = createDefaultRegistry();

export default defaultRegistry;
