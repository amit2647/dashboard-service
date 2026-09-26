const {
  leadServiceUrl,
  customerServiceUrl,
  serviceServiceUrl,
} = require("../config/services");

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
const SOURCE_PERMISSIONS = ["leads.read", "customers.read", "services.read"];

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

  const demandMap = {};

  function addServiceDemand(records) {
    records.forEach((record) => {
      const recordServices = getServiceNames(record);

      recordServices.forEach((serviceName) => {
        demandMap[serviceName] = (demandMap[serviceName] || 0) + 1;
      });
    });
  }

  addServiceDemand(leads);
  addServiceDemand(customers);

  /*
   * Resolve service IDs into service names.
   *
   * Example:
   *
   * "1": 5
   *
   * becomes:
   *
   * "CRM Implementation": 5
   */

  services.forEach((service) => {
    const serviceId = String(service.id);

    if (demandMap[serviceId] !== undefined) {
      const count = demandMap[serviceId];

      delete demandMap[serviceId];

      demandMap[service.name] = (demandMap[service.name] || 0) + count;
    }
  });

  const serviceDemand = Object.entries(demandMap)
    .map(([name, count]) => ({
      name,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

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
};
