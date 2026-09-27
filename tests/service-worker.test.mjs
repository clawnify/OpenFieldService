import test from "node:test";
import assert from "node:assert/strict";

test("service worker leaves non-field API reads network-only", async () => {
  const originalSelf = globalThis.self;
  const listeners = new Map();
  globalThis.self = {
    location: new URL("https://field.example/"),
    addEventListener(type, listener) { listeners.set(type, listener); },
  };

  try {
    await import(`../public/service-worker.js?test=${Date.now()}`);
    const fetchListener = listeners.get("fetch");
    assert.equal(typeof fetchListener, "function");

    let response;
    fetchListener({
      request: new Request("https://field.example/api/customers", { method: "GET" }),
      respondWith(value) { response = value; },
    });
    assert.equal(response, undefined);

    fetchListener({
      request: new Request("https://field.example/api/invoices?page=1", { method: "GET" }),
      respondWith(value) { response = value; },
    });
    assert.equal(response, undefined);
  } finally {
    if (originalSelf === undefined) Reflect.deleteProperty(globalThis, "self");
    else globalThis.self = originalSelf;
  }
});
