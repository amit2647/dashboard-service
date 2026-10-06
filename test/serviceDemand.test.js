const { test } = require("node:test");
const assert = require("node:assert/strict");

const { serviceDemandOf } = require("../src/services/dashboardService");

/*
 * A converted lead and the customer it became are one entity, so service
 * demand counts the customer's services and not the lead's old enquiry.
 * Before this, a client mapped to one service showed three in demand.
 */

const services = [
  { id: 1, name: "CRM Implementation" },
  { id: 2, name: "Consulting" },
  { id: 3, name: "TDS Returns" },
];

test("a converted lead's services are not counted on top of its customer's", () => {
  const leads = [
    { name: "Andres Pirlo", status: "Converted", services: [{ id: 1, name: "CRM Implementation" }] },
    { name: "Thiago Silva", status: "Converted", services: [{ id: 2, name: "Consulting" }] },
  ];
  const customers = [{ name: "Andres Pirlo", services: [{ id: 3, name: "TDS Returns" }] }];

  assert.deepEqual(serviceDemandOf(leads, customers, services), [{ name: "TDS Returns", count: 1 }]);
});

test("open leads still count as demand, alongside customers", () => {
  const leads = [
    { name: "New enquiry", status: "New", services: [{ id: 3, name: "TDS Returns" }] },
    { name: "Talking", status: "Qualified", serviceIds: [2] },
  ];
  const customers = [{ name: "Client", services: [{ id: 3, name: "TDS Returns" }] }];

  assert.deepEqual(serviceDemandOf(leads, customers, services), [
    { name: "TDS Returns", count: 2 },
    { name: "Consulting", count: 1 },
  ]);
});
