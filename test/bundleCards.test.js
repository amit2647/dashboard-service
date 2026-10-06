const { test } = require("node:test");
const assert = require("node:assert/strict");

const { bundleCardsOf } = require("../src/services/dashboardService");

/*
 * A profession bundle's dashboard cards (DASH-01): named queries over the
 * caller's own view of clients and this year's deadlines, each card shown
 * only to someone with its permission.
 */

const CARDS = [
  { key: "clients", label: "Clients", permission: "customers.read", query: { name: "clients_total" } },
  { key: "statutory", label: "Statutory audits", permission: "customers.read", query: { name: "clients_with_service", params: { services: ["statutory_audit"] } } },
  { key: "gst", label: "GST clients", permission: "customers.read", query: { name: "clients_with_service", params: { services: ["gst_returns", "gstr9", "gstr9c"] } } },
  { key: "overdue", label: "Overdue", permission: "obligations.read", query: { name: "obligations_by_state", params: { state: "overdue" } } },
];

const customers = [
  { attributes: { client_type: "regular" }, services: [{ key: "statutory_audit" }, { key: "gst_returns" }] },
  { attributes: { client_type: "one_time" }, services: [{ key: "gstr9" }, { key: "gstr9c" }] },
  { attributes: {}, services: [{ key: "itr" }] },
];

const valueOf = (cards, key) => cards.find((card) => card.key === key)?.value;

test("counts clients, splitting regular and one-time", () => {
  const cards = bundleCardsOf(CARDS, { customers, permissions: ["customers.read"], deadlineCounts: null });

  assert.equal(valueOf(cards, "clients"), 3);
  assert.equal(cards[0].hint, "2 regular · 1 one-time");
});

test("a client taking any of a card's services counts once", () => {
  const cards = bundleCardsOf(CARDS, { customers, permissions: ["customers.read"], deadlineCounts: null });

  assert.equal(valueOf(cards, "statutory"), 1);
  assert.equal(valueOf(cards, "gst"), 2);
});

test("deadline cards read this year's counts, and need obligations.read", () => {
  assert.equal(bundleCardsOf(CARDS, { customers, permissions: ["customers.read"], deadlineCounts: { overdue: 4 } }).some((card) => card.key === "overdue"), false);
  assert.equal(valueOf(bundleCardsOf(CARDS, { customers, permissions: ["customers.read", "obligations.read"], deadlineCounts: { overdue: 4 } }), "overdue"), 4);
});

test("an unknown query shows no figure rather than a wrong one", () => {
  const [card] = bundleCardsOf([{ key: "x", label: "X", query: { name: "no_such_query" } }], { customers, permissions: [], deadlineCounts: null });

  assert.equal(card.value, null);
});

test("counts open prospects — not converted, not lost — and how many have a quote", () => {
  const cards = bundleCardsOf(
    [{ key: "prospects", label: "Prospects", permission: "leads.read", query: { name: "prospects_open" } }],
    {
      customers: [],
      leads: [
        { status: "New", quoted_fee: null },
        { status: "Quote Sent", quoted_fee: "45000.00" },
        { status: "Converted", quoted_fee: "10000.00" },
        { status: "Lost" },
      ],
      permissions: ["leads.read"],
      deadlineCounts: null,
    },
  );

  assert.equal(cards[0].value, 2);
  assert.equal(cards[0].hint, "1 with a quote");
});

test("the prospects card needs leads.read", () => {
  const cards = bundleCardsOf([{ key: "prospects", label: "Prospects", permission: "leads.read", query: { name: "prospects_open" } }], { customers: [], leads: [{ status: "New" }], permissions: ["customers.read"], deadlineCounts: null });

  assert.deepEqual(cards, []);
});
