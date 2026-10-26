// The VAPID subject push services are given (src/lib/push.js): the operator's own, never a hard-coded person's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vapidSubject } from "../src/lib/push.js";

describe("VAPID subject", () => {
  it("VAPID_SUBJECT from the environment wins, mailto or https", () => {
    assert.equal(vapidSubject({ VAPID_SUBJECT: "mailto:me@my-domain.dev" }, "mailto:old@x.io"), "mailto:me@my-domain.dev");
    assert.equal(vapidSubject({ VAPID_SUBJECT: " https://agent.my-domain.dev " }), "https://agent.my-domain.dev");
  });

  it("unset: a saved subject, then the Railway address, then a neutral placeholder", () => {
    assert.equal(vapidSubject({}, "mailto:saved@x.io"), "mailto:saved@x.io");
    assert.equal(vapidSubject({ RAILWAY_PUBLIC_DOMAIN: "tarsee-production-1a2b.up.railway.app" }), "https://tarsee-production-1a2b.up.railway.app");
    assert.equal(vapidSubject({}), "mailto:admin@example.com");
  });

  it("a value that is not a mailto: or https: URL is ignored, not passed to web-push (which would throw)", () => {
    assert.equal(vapidSubject({ VAPID_SUBJECT: "me@my-domain.dev", RAILWAY_PUBLIC_DOMAIN: "a.up.railway.app" }), "https://a.up.railway.app");
    assert.equal(vapidSubject({ VAPID_SUBJECT: "http://insecure.example" }), "mailto:admin@example.com");
    assert.equal(vapidSubject({}, "not a url"), "mailto:admin@example.com");
  });
});
