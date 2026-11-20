/**
 * Boot-time installation of the official-frontend compatibility handlers.
 *
 * The shell answers registered-but-missing routes with a structured 501. The
 * handler lanes register their routes on a private registry in unit tests;
 * this module binds every lane to the shared `defaultRegistry` the server
 * actually dispatches from.
 *
 * `ctx` is the `PiHiveServer` instance (most importantly `ctx.runtimes`), so
 * handlers that report live state can read it. The server also passes `ctx`
 * per call, and a per-call ctx wins inside every handler.
 *
 * Registration is idempotent: `RouteRegistry.register` replaces the same
 * method + path instead of appending, and `reconcileParamShadows` retires
 * placeholder routes that spell the same path with a different parameter name
 * (e.g. `/api/sessions/:id` vs `/api/sessions/:session`). The router keeps the
 * first entry on a specificity tie, so without that cleanup the older
 * structured-501 placeholder would shadow the real handler.
 */

import { defaultRegistry, ROUTE_STATUS } from "./router.js";
import { registerConfigRoutes } from "./handlers/config.js";
import {
  CONFIG_EXTRA_ROUTES,
  registerConfigExtraRoutes,
} from "./handlers/config-extra.js";
import { registerOrganizationRoutes } from "./handlers/organization.js";
import { registerSessionRoutes } from "./handlers/sessions.js";
import { registerQueenRoutes } from "./handlers/queens.js";
import { CATALOG_ROUTE_SPECS, registerCatalogRoutes } from "./handlers/catalog.js";
import { registerColoniesDataRoutes } from "./handlers/colonies-data.js";
import { registerGlobalDataRoutes } from "./handlers/global-data.js";
import { registerAutonomyRoutes } from "./handlers/autonomy.js";
import { registerStreamRoutes } from "./handlers/streams.js";

/**
 * Writes that used to answer `400 unsupported_capability`. Every one of them is a
 * real implementation now (config store, provider library, model slots, endpoint
 * registry, credential vault, credential form), so the list is empty and the
 * installer no longer downgrades any of them to `partial`.
 */
const CONFIG_EXTRA_UNSUPPORTED_WRITES = new Set([]);


/** Catalogue routes whose handler is real but answers an explicit 400/empty. */
const LIMITED_CATALOG_ROUTES = new Set(
  CATALOG_ROUTE_SPECS.filter((spec) => spec.compatibility === "limited").map(
    (spec) => `${spec.method} ${spec.path}`,
  ),
);

/** Shape key: `:a` and `:b` in the same position are the same route shape. */
function shapeKey(route) {
  const shape = route.path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
  return `${route.method} ${shape}`;
}

/**
 * Prefer the route that can answer: a real handler beats a null handler, an
 * official route beats a native placeholder, and a later registration beats an
 * earlier one. Only routes with an identical segment shape compete; static
 * paths never shadow params here (the router already scores those).
 */
function routeRank(route) {
  const hasHandler = typeof route.handler === "function" ? 2 : 0;
  const official = route.meta?.official === true ? 1 : 0;
  return hasHandler + official;
}

/** Remove same-shape placeholders that would win a specificity tie. */
function reconcileParamShadows(registry) {
  const winners = new Map();
  for (const route of registry.routes) {
    const key = shapeKey(route);
    const current = winners.get(key);
    if (!current || routeRank(route) >= routeRank(current)) winners.set(key, route);
  }
  registry.routes = registry.routes.filter(
    (route) => winners.get(shapeKey(route)) === route,
  );
}

/** Re-register one existing route with a new compatibility status. */
function setRouteStatus(registry, method, path, status, extra = {}) {
  const route = registry.routes.find(
    (entry) => entry.method === method && entry.path === path,
  );
  if (!route) throw new Error(`cannot set status for unregistered route: ${method} ${path}`);
  registry.register(method, path, route.handler, {
    ...route.meta,
    ...extra,
    status,
  });
}

/**
 * Register every official handler lane on `registry` (default: the shared
 * registry the server dispatches from).
 *
 * @param {object} [ctx] server instance, e.g. `{ runtimes: Map }`
 * @param {import("./router.js").RouteRegistry} [registry]
 * @returns {import("./router.js").RouteRegistry} the registry, for chaining
 */
export function installCompatHandlers(ctx = {}, registry = defaultRegistry) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("installCompatHandlers(ctx, registry): registry.register is required");
  }

  // The streams lane owns GET /api/sessions/:session/events. An older shell
  // pattern spelled the same route with `:id`; both match, so retire the
  // legacy entry to keep the official transport unambiguous regardless of the
  // order the lanes are registered in.
  registry.remove("GET", "/api/sessions/:id/events");

  registerConfigRoutes(registry, ctx);
  registerConfigExtraRoutes(registry, ctx);
  // The organization lane owns /api/discover; its handler supersedes config's
  // duplicate registration for that method+path (register() replaces).
  registerOrganizationRoutes(registry, ctx);
  // Sessions must win GET /api/sessions over organization's empty-list
  // handler, and it retires the `:id` placeholders it replaces.
  registerSessionRoutes(registry, ctx);
  registerQueenRoutes(registry, ctx);
  // Catalogue owns /api/prompts (replacing config's empty prompt list).
  registerCatalogRoutes(registry, ctx);
  registerColoniesDataRoutes(registry, ctx);
  registerGlobalDataRoutes(registry, ctx);
  registerAutonomyRoutes(registry, ctx);
  registerStreamRoutes(registry, ctx);

  // Honest compatibility statuses: a route whose handler refuses the mutation
  // is partial, not implemented. Both statuses dispatch because
  // `PiHiveServer.isDispatchable` accepts official routes that have a handler.
  for (const route of CONFIG_EXTRA_ROUTES) {
    if (CONFIG_EXTRA_UNSUPPORTED_WRITES.has(`${route.method} ${route.path}`)) {
      setRouteStatus(registry, route.method, route.path, ROUTE_STATUS.PARTIAL, {
        limited: true,
        compatibility: "limited",
        reason: "explicit 400 unsupported_capability: pi_hive has no backing store for this write",
      });
    }
  }
  for (const spec of CATALOG_ROUTE_SPECS) {
    if (LIMITED_CATALOG_ROUTES.has(`${spec.method} ${spec.path}`)) {
      setRouteStatus(registry, spec.method, spec.path, ROUTE_STATUS.PARTIAL, {
        limited: true,
        reason: "real handler, but the official capability has no pi_hive backing store (explicit 400 or empty collection)",
      });
    }
  }

  // Retire older `:id`/`:name` placeholders that would shadow an official
  // handler on a specificity tie.
  reconcileParamShadows(registry);

  // GET /api/colonies is native: handleApi answers it with raw colony metadata
  // for the /ui/ dashboard. Keep the registry entry partial with no handler so
  // it always falls through to handleApi even though the organization lane can
  // build the official ColonySummary shape. Registered after reconciliation so
  // the null-handler native entry is the one that stays.
  registry.register("GET", "/api/colonies", null, {
    status: ROUTE_STATUS.PARTIAL,
    description: "native pi_hive colony list for /ui/; official ColonySummary shape not served",
  });

  return registry;
}

export default installCompatHandlers;
