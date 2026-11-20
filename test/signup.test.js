import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import handler, {
  parseSubmission,
  verifySharedToken,
  verifyWebflowSignature
} from "../api/signup.js";

const secret = "local-test-secret";

function validBody() {
  return {
    triggerType: "form_submission",
    payload: {
      name: "Kontakt formulär",
      siteId: "63d8dc2e02e18015b08398f3",
      formId: "form-id",
      id: "submission-123",
      submittedAt: "2026-11-20T12:00:00.000Z",
      data: {
        name: "Test Person",
        email: "test@example.invalid",
        ssn: "19900101-1234",
        street: "Testgatan 1",
        zip: "123 45",
        city: "Teststad"
      }
    }
  };
}

function signedHeaders(body, timestamp = Date.now()) {
  return {
    "x-webflow-timestamp": String(timestamp),
    "x-webflow-signature": crypto.createHmac("sha256", secret)
      .update(`${timestamp}:${JSON.stringify(body)}`).digest("hex")
  };
}

function responseRecorder() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("verifies a fresh Webflow signature", () => {
  const body = validBody();
  const now = Date.now();
  assert.equal(verifyWebflowSignature({
    body, headers: signedHeaders(body, now), secret, now
  }), true);
});

test("rejects an expired Webflow signature", () => {
  const body = validBody();
  const timestamp = Date.now() - 6 * 60 * 1000;
  assert.equal(verifyWebflowSignature({
    body, headers: signedHeaders(body, timestamp), secret, now: Date.now()
  }), false);
});

test("verifies a shared webhook token with a timing-safe comparison", () => {
  assert.equal(verifySharedToken({ actual: "shared-token", expected: "shared-token" }), true);
  assert.equal(verifySharedToken({ actual: "wrong-token", expected: "shared-token" }), false);
});

test("normalizes and validates the expected form", () => {
  const result = parseSubmission(validBody());
  assert.equal(result.submissionId, "submission-123");
  assert.equal(result.billectaPayload.ssn, "199001011234");
  assert.equal(result.billectaPayload.address.zip, "12345");
});

test("accepts a valid signed request in safe dry-run mode", async () => {
  const body = validBody();
  process.env.WEBFLOW_WEBHOOK_SECRET = secret;
  delete process.env.BILLECTA_DRY_RUN;
  const res = responseRecorder();
  await handler({ method: "POST", body, headers: signedHeaders(body), query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
});

test("rejects an unsigned request before calling Billecta", async () => {
  process.env.WEBFLOW_WEBHOOK_SECRET = secret;
  const res = responseRecorder();
  await handler({ method: "POST", body: validBody(), headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("accepts a valid shared token in dry-run mode", async () => {
  const body = validBody();
  process.env.WEBFLOW_SHARED_TOKEN = "shared-token";
  delete process.env.BILLECTA_DRY_RUN;
  const res = responseRecorder();
  await handler({
    method: "POST",
    body,
    headers: {},
    query: { token: "shared-token" }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
});

test("uses Billecta's unique call header when live mode is explicitly enabled", async () => {
  const body = validBody();
  process.env.WEBFLOW_WEBHOOK_SECRET = secret;
  process.env.BILLECTA_DRY_RUN = "false";
  process.env.BILLECTA_KEY = "test-key";
  process.env.BILLECTA_API_BASE_URL = "https://apitest.billecta.com";
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };
  try {
    const res = responseRecorder();
    await handler({ method: "POST", body, headers: signedHeaders(body), query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(request.url, "https://apitest.billecta.com/v1/debtors/debtor");
    assert.equal(request.options.headers.UniqueApiCallId, "wf-submission-123");
  } finally {
    global.fetch = originalFetch;
  }
});
