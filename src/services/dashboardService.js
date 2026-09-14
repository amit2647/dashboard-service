const {
  leadServiceUrl,
  customerServiceUrl,
  serviceServiceUrl,
} = require("../config/services");

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
      ...(authorizationToken
        ? {
            Authorization: authorizationToken,
          }
        : {}),
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
 * DISPLAY HELPERS
 * =========================================================
 */

function getServiceReferences(record) {
  if (!record) {
    return [];
  }

  if (Array.isArray(record.services)) {
    return record.services
      .map((service) => {
        if (typeof service === "string") {
          return {
            id: null,
            name: service,
          };
        }

        return {
          id: service?.id ?? service?.serviceId ?? null,
          name: service?.name || service?.serviceName || null,
        };
      })
      .filter((service) => service.id !== null || service.name);
  }

  if (Array.isArray(record.serviceIds)) {
    return record.serviceIds
      .map((serviceId) => ({
        id: serviceId,
        name: null,
      }))
      .filter((service) => service.id !== null);
  }

  return [];
}

function getServiceNames(record, serviceById = new Map()) {
  const references = getServiceReferences(record);

  return references
    .map((service) => {
      if (service.name) {
        return service.name;
      }

      const resolved = serviceById.get(String(service.id));

      return resolved?.name || `Service #${service.id}`;
    })
    .filter(Boolean);
}

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

async function getDashboardData(authorizationToken) {
  const startedAt = Date.now();

  /*
   * =======================================================
   * FETCH DOMAIN DATA IN PARALLEL
   * =======================================================
   *
   * Dashboard Service acts only as an aggregation layer.
   *
   * It does not access another service's database.
   */

  const [leadData, customerData, serviceData] = await Promise.all([
    getJson(`${leadServiceUrl}/leads`, authorizationToken),

    getJson(`${customerServiceUrl}/customers`, authorizationToken),

    getJson(`${serviceServiceUrl}/services`, authorizationToken),
  ]);

  const leads = Array.isArray(leadData) ? leadData : leadData?.leads || [];

  const customers = Array.isArray(customerData)
    ? customerData
    : customerData?.customers || [];

  const services = Array.isArray(serviceData)
    ? serviceData
    : serviceData?.services || [];

  /*
   * =======================================================
   * SERVICE LOOKUP
   * =======================================================
   */

  const serviceById = new Map();

  services.forEach((service) => {
    if (service?.id !== undefined && service?.id !== null) {
      serviceById.set(String(service.id), service);
    }
  });

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
      const recordServices = getServiceNames(record, serviceById);

      recordServices.forEach((serviceName) => {
        demandMap[serviceName] = (demandMap[serviceName] || 0) + 1;
      });
    });
  }

  addServiceDemand(leads);
  addServiceDemand(customers);

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
      getServiceReferences(lead).length === 0,
  );

  if (qualifiedWithoutServices.length > 0) {
    attentionItems.push({
      type: "warning",
      title: "Qualified leads need services",
      description:
        `${qualifiedWithoutServices.length} qualified lead` +
        `${qualifiedWithoutServices.length === 1 ? "" : "s"} ` +
        "have no services assigned.",
      count: qualifiedWithoutServices.length,
      link: "/leads",
      action: "Review leads",
    });
  }

  const leadsWithoutServices = leads.filter(
    (lead) => getServiceReferences(lead).length === 0,
  );

  if (leadsWithoutServices.length > 0) {
    attentionItems.push({
      type: "info",
      title: "Leads without services",
      description:
        `${leadsWithoutServices.length} lead` +
        `${leadsWithoutServices.length === 1 ? "" : "s"} ` +
        "currently have no service mapping.",
      count: leadsWithoutServices.length,
      link: "/leads",
      action: "Assign services",
    });
  }

  const customersWithoutServices = customers.filter(
    (customer) => getServiceReferences(customer).length === 0,
  );

  if (customersWithoutServices.length > 0) {
    attentionItems.push({
      type: "neutral",
      title: "Customers without services",
      description:
        `${customersWithoutServices.length} customer` +
        `${customersWithoutServices.length === 1 ? "" : "s"} ` +
        "have no services assigned.",
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

  const activeServices = services.filter(
    (service) => normalizeStatus(service.status) === "active",
  ).length;

  /*
   * =======================================================
   * RESPONSE
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
   * PERFORMANCE LOGGING
   * =======================================================
   */

  console.log(
    `[Dashboard] Aggregated ${leads.length} leads, ` +
      `${customers.length} customers and ` +
      `${services.length} services in ` +
      `${Date.now() - startedAt}ms`,
  );

  return dashboard;
}

module.exports = {
  getDashboardData,
};
