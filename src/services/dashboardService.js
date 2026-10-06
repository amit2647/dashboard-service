const {
  leadServiceUrl,
  customerServiceUrl,
  serviceServiceUrl,
  obligationServiceUrl,
} = require("../config/services");
const { installedBundle } = require("./bundleContext");

const { redisClient } = require("../config/redis");

/*
 * =========================================================
 * HTTP HELPERS
 * =========================================================
 */

async function getJson(url, authorizationToken) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authorizationToken,
    },
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
        data?.message ||
        `Request failed with status ${response.status}`,
    );

    error.statusCode = response.status;

    throw error;
  }

  return data;
}

/*
 * =========================================================
 * NORMALIZATION
 * =========================================================
 */

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/*
 * =========================================================
 * SERVICE HELPERS
 * =========================================================
 */

function getServiceNames(record) {
  if (!record) {
    return [];
  }

  /*
   * Preferred format:
   *
   * services: [
   *   {
   *     id: 1,
   *     name: "CRM Implementation"
   *   }
   * ]
   */

  if (Array.isArray(record.services)) {
    return record.services
      .map((service) => {
        if (typeof service === "string") {
          return service;
        }

        return service?.name || service?.serviceName;
      })
      .filter(Boolean);
  }

  /*
   * Fallback:
   *
   * serviceIds: [1, 2, 3]
   *
   * These will be resolved against the service
   * catalog later.
   */

  if (Array.isArray(record.serviceIds)) {
    return record.serviceIds
      .map((serviceId) => String(serviceId))
      .filter(Boolean);
  }

  return [];
}

/*
 * =========================================================
 * DATE HELPERS
 * =========================================================
 */

function getDateValue(record) {
  return (
    record?.createdAt ||
    record?.created_at ||
    record?.updatedAt ||
    record?.updated_at ||
    null
  );
}

/*
 * =========================================================
 * DASHBOARD DATA
 * =========================================================
 */

/*
 * The dashboard is built from the caller's own view of leads, customers and
 * services — each fetched with their token. Which of those they can read
 * decides what the figures contain, so it is part of the cache key: otherwise
 * someone granted only the Dashboard would be served figures (and recent lead
 * names) computed for an admin who loaded it moments earlier.
 */
// What the figures are built from; the cache is shared only between callers
// who can read the same of these. obligations.read feeds the bundle cards.
const SOURCE_PERMISSIONS = ["leads.read", "customers.read", "services.read", "obligations.read"];

/*
 * A profession bundle's cards (DASH-01): each names a query and its
 * parameters; this is where the queries live. A card the caller has no
 * permission for is left out. Pure apart from the deadline counts, which are
 * fetched once and passed in.
 *
 *   clients_total        — every client, hint: regular / one-time
 *   clients_with_service — clients taking any of params.services (keys)
 *   obligations_by_state — this year's deadlines in params.state
 */
function bundleCardsOf(cards, { customers, leads = [], permissions, deadlineCounts }) {
  const held = new Set(Array.isArray(permissions) ? permissions : []);
  const serviceKeysOf = (customer) => new Set((customer.services || []).map((service) => service.key).filter(Boolean));

  return (cards || [])
    .filter((card) => !card.permission || held.has(card.permission))
    .map((card) => {
      const params = card.query?.params || {};
      let value = null;
      let hint = null;

      switch (card.query?.name) {
        case "clients_total": {
          const oneTime = customers.filter((customer) => customer.attributes?.client_type === "one_time").length;
          value = customers.length;
          hint = `${customers.length - oneTime} regular · ${oneTime} one-time`;
          break;
        }
        case "clients_with_service": {
          const wanted = Array.isArray(params.services) ? params.services : [];
          value = customers.filter((customer) => wanted.some((key) => serviceKeysOf(customer).has(key))).length;
          break;
        }
        case "prospects_open": {
          // Prospects still being worked: not yet a client, not lost.
          const open = leads.filter((lead) => !["converted", "lost"].includes(normalizeStatus(lead.status)));
          const quoted = open.filter((lead) => lead.quoted_fee !== null && lead.quoted_fee !== undefined && lead.quoted_fee !== "").length;
          value = open.length;
          hint = `${quoted} with a quote`;
          break;
        }
        case "obligations_by_state":
          value = deadlineCounts ? deadlineCounts[params.state] ?? 0 : null;
          break;
        default:
          value = null;
      }

      return { key: card.key, label: card.label, query: card.query?.name || null, params, value, hint };
    });
}

/*
 * Service demand: how many leads and customers carry each service, top five.
 *
 * A converted lead and the customer it became are one entity (migration 017),
 * so a converted lead is not counted: the customer's services are the current
 * truth, and the lead's are what was asked for before conversion. Counting
 * both showed a client's old enquiry as demand on top of what they now take.
 */
function serviceDemandOf(leads, customers, services) {
  const demandMap = {};

  function addServiceDemand(records) {
    records.forEach((record) => {
      getServiceNames(record).forEach((serviceName) => {
        demandMap[serviceName] = (demandMap[serviceName] || 0) + 1;
      });
    });
  }

  addServiceDemand(leads.filter((lead) => normalizeStatus(lead.status) !== "converted"));
  addServiceDemand(customers);

  // Resolve service ids into names: { "1": 5 } becomes { "CRM Implementation": 5 }.
  services.forEach((service) => {
    const serviceId = String(service.id);

    if (demandMap[serviceId] !== undefined) {
      const count = demandMap[serviceId];

      delete demandMap[serviceId];

      demandMap[service.name] = (demandMap[service.name] || 0) + count;
    }
  });

  return Object.entries(demandMap)
    .map(([name, count]) => ({
      name,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function readScope(permissions) {
  const held = new Set(Array.isArray(permissions) ? permissions : []);

  return SOURCE_PERMISSIONS.filter((permission) => held.has(permission)).join(",") || "none";
}

/*
 * A source the caller may not read counts as empty rather than failing the
 * whole dashboard. Any other failure still propagates.
 */
async function getJsonOrEmpty(url, authorizationToken) {
  try {
    return await getJson(url, authorizationToken);
  } catch (error) {
    if (error.statusCode === 403) {
      return [];
    }

    throw error;
  }
}

async function getDashboardData(authorizationToken, organizationId, permissions) {
  if (!organizationId) {
    const error = new Error("Organization context is required.");

    error.statusCode = 400;

    throw error;
  }

  /*
   * =======================================================
   * REDIS CACHE
   * =======================================================
   *
   * Cache is tenant scoped.
   *
   * Example:
   *
   * dashboard:org:1
   * dashboard:org:2
   *
   * This prevents one organization's dashboard
   * from being returned to another organization.
   */

  const cacheKey = `dashboard:org:${organizationId}:${readScope(permissions)}`;

  try {
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      console.log(`[Dashboard Cache] HIT ${cacheKey}`);

      return JSON.parse(cached);
    }

    console.log(`[Dashboard Cache] MISS ${cacheKey}`);
  } catch (error) {
    /*
     * Redis should never make the dashboard
     * completely unavailable.
     *
     * If Redis fails, fall back to the domain
     * services.
     */

    console.error("[Dashboard Cache] Read failed:", error);
  }

  /*
   * =======================================================
   * DOMAIN SERVICE REQUESTS
   * =======================================================
   *
   * Dashboard Service does not access domain
   * databases directly.
   *
   * It obtains data through:
   *
   * Lead Service
   * Customer Service
   * Service Service
   */

  const [leadData, customerData, serviceData] = await Promise.all([
    getJsonOrEmpty(`${leadServiceUrl}/leads`, authorizationToken),

    getJsonOrEmpty(`${customerServiceUrl}/customers`, authorizationToken),

    getJsonOrEmpty(`${serviceServiceUrl}/services`, authorizationToken),
  ]);

  /*
   * =======================================================
   * NORMALIZE API RESPONSES
   * =======================================================
   */

  const leads = Array.isArray(leadData) ? leadData : leadData?.leads || [];

  const customers = Array.isArray(customerData)
    ? customerData
    : customerData?.customers || [];

  const services = Array.isArray(serviceData)
    ? serviceData
    : serviceData?.services || [];

  /*
   * =======================================================
   * KPI METRICS
   * =======================================================
   */

  const qualifiedLeads = leads.filter(
    (lead) => normalizeStatus(lead.status) === "qualified",
  ).length;

  const convertedLeads = leads.filter(
    (lead) => normalizeStatus(lead.status) === "converted",
  ).length;

  const conversionRate =
    leads.length > 0
      ? Math.round((convertedLeads / leads.length) * 1000) / 10
      : 0;

  /*
   * =======================================================
   * PIPELINE
   * =======================================================
   */

  const pipelineStages = [
    {
      key: "new",
      label: "New",
    },
    {
      key: "contacted",
      label: "Contacted",
    },
    {
      key: "qualified",
      label: "Qualified",
    },
    {
      key: "converted",
      label: "Converted",
    },
    {
      key: "lost",
      label: "Lost",
    },
  ];

  const pipeline = pipelineStages.map((stage) => {
    const count = leads.filter(
      (lead) => normalizeStatus(lead.status) === stage.key,
    ).length;

    const percentage =
      leads.length > 0 ? Math.round((count / leads.length) * 100) : 0;

    return {
      ...stage,
      count,
      percentage,
    };
  });

  /*
   * =======================================================
   * LEAD SOURCES
   * =======================================================
   */

  const sourceMap = {};

  leads.forEach((lead) => {
    const source = lead.channel || lead.source || lead.leadSource || "Unknown";

    const normalized = String(source).trim();

    if (!normalized) {
      return;
    }

    sourceMap[normalized] = (sourceMap[normalized] || 0) + 1;
  });

  const leadSources = Object.entries(sourceMap)
    .map(([name, count]) => ({
      name,
      count,
      percentage:
        leads.length > 0 ? Math.round((count / leads.length) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  /*
   * =======================================================
   * SERVICE DEMAND
   * =======================================================
   */

  const serviceDemand = serviceDemandOf(leads, customers, services);

  /*
   * =======================================================
   * PROFESSION BUNDLE CARDS
   * =======================================================
   *
   * Only for an organization with a bundle that ships cards; nothing is
   * added otherwise, so its dashboard is exactly as before.
   */

  let bundleCards = null;
  // authorizationToken is the whole header; bundleContext (a shared copy) adds "Bearer ".
  const bundleToken = String(authorizationToken || "").replace(/^Bearer\s+/i, "");
  const bundle = await installedBundle(organizationId, bundleToken).catch((error) => {
    console.error(`[Dashboard] bundle lookup failed: ${error.message}`);
    return null;
  });

  if (bundle && Array.isArray(bundle.dashboard) && bundle.dashboard.length > 0) {
    const wantsDeadlines = bundle.dashboard.some((card) => card.query?.name === "obligations_by_state") && (permissions || []).includes("obligations.read");
    const deadlines = wantsDeadlines ? await getJsonOrEmpty(`${obligationServiceUrl}/obligations`, authorizationToken).catch(() => null) : null;

    bundleCards = bundleCardsOf(bundle.dashboard, { customers, leads, permissions, deadlineCounts: deadlines?.counts || null });
  }

  /*
   * =======================================================
   * RECENT LEADS
   * =======================================================
   */

  const recentLeads = [...leads]
    .sort((a, b) => {
      const dateA = new Date(getDateValue(a) || 0).getTime();

      const dateB = new Date(getDateValue(b) || 0).getTime();

      return dateB - dateA;
    })
    .slice(0, 5);

  /*
   * =======================================================
   * NEEDS ATTENTION
   * =======================================================
   */

  const attentionItems = [];

  const qualifiedWithoutServices = leads.filter(
    (lead) =>
      normalizeStatus(lead.status) === "qualified" &&
      getServiceNames(lead).length === 0,
  );

  if (qualifiedWithoutServices.length > 0) {
    attentionItems.push({
      type: "warning",

      title: "Qualified leads need services",

      description:
        `${qualifiedWithoutServices.length} qualified lead` +
        `${
          qualifiedWithoutServices.length === 1 ? "" : "s"
        } have no services assigned.`,

      count: qualifiedWithoutServices.length,

      link: "/leads",

      action: "Review leads",
    });
  }

  const leadsWithoutServices = leads.filter(
    (lead) => getServiceNames(lead).length === 0,
  );

  if (leadsWithoutServices.length > 0) {
    attentionItems.push({
      type: "info",

      title: "Leads without services",

      description:
        `${leadsWithoutServices.length} lead` +
        `${
          leadsWithoutServices.length === 1 ? "" : "s"
        } currently have no service mapping.`,

      count: leadsWithoutServices.length,

      link: "/leads",

      action: "Assign services",
    });
  }

  const customersWithoutServices = customers.filter(
    (customer) => getServiceNames(customer).length === 0,
  );

  if (customersWithoutServices.length > 0) {
    attentionItems.push({
      type: "neutral",

      title: "Customers without services",

      description:
        `${customersWithoutServices.length} customer` +
        `${
          customersWithoutServices.length === 1 ? "" : "s"
        } have no services assigned.`,

      count: customersWithoutServices.length,

      link: "/customers",

      action: "Review customers",
    });
  }

  /*
   * =======================================================
   * SERVICE CATALOG
   * =======================================================
   */

  const activeServices = services.filter((service) => {
    const status = normalizeStatus(service.status);

    return !status || status === "active" || status === "enabled";
  }).length;

  /*
   * =======================================================
   * FINAL DASHBOARD RESPONSE
   * =======================================================
   */

  const dashboard = {
    metrics: {
      totalLeads: leads.length,
      totalCustomers: customers.length,
      qualifiedLeads,
      convertedLeads,
      conversionRate,
    },

    pipeline,

    leadSources: leadSources.slice(0, 5),

    recentLeads,

    serviceDemand,

    attentionItems: attentionItems.slice(0, 4),

    serviceCatalog: {
      totalServices: services.length,

      activeServices,

      servicesInDemand: serviceDemand.length,
    },

    managedRecords: leads.length + customers.length,

    bundleCards,

    generatedAt: new Date().toISOString(),
  };

  /*
   * =======================================================
   * REDIS CACHE WRITE
   * =======================================================
   *
   * Cache for 30 seconds.
   *
   * If Redis write fails, the dashboard
   * response is still returned normally.
   */

  try {
    await redisClient.set(cacheKey, JSON.stringify(dashboard), {
      EX: 30,
    });

    console.log(`[Dashboard Cache] SET ${cacheKey} TTL=30s`);
  } catch (error) {
    console.error("[Dashboard Cache] Write failed:", error);
  }

  return dashboard;
}

module.exports = {
  getDashboardData,
  readScope,
  serviceDemandOf,
  bundleCardsOf,
};
