const { test } = require("node:test");
const assert = require("node:assert/strict");

const { readScope } = require("../src/services/dashboardService");

/*
 * The dashboard cache is shared only between callers who can read the same
 * sources. Before this, it was keyed by organization alone, so a Dashboard-only
 * grant could be served an admin's figures and recent lead names.
 */

test("callers with different read access get different cache scopes", () => {
  assert.notEqual(
    readScope(["reports.read"]),
    readScope(["reports.read", "leads.read", "customers.read", "services.read"]),
  );
});

test("the scope ignores permissions that do not change the figures", () => {
  assert.equal(
    readScope(["leads.read", "users.read", "reports.read"]),
    readScope(["leads.read", "email.send"]),
  );
});

test("order does not matter", () => {
  assert.equal(readScope(["services.read", "leads.read"]), readScope(["leads.read", "services.read"]));
});

test("no readable sources is its own scope", () => {
  assert.equal(readScope([]), "none");
  assert.equal(readScope(undefined), "none");
});
