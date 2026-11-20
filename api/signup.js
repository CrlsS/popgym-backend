import crypto from "node:crypto";

const WEBFLOW_SITE_ID = "63d8dc2e02e18015b08398f3";
const WEBFLOW_FORM_NAME = "Kontakt formulär";
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;
const BILLECTA_PRODUCTION_URL = "https://api.billecta.com";
const BILLECTA_TEST_URL = "https://apitest.billecta.com";
const DEFAULT_CREDITOR_PUBLIC_ID = "a41edb49-f116-40dc-b0ba-611080b4bdc7";

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function verifyWebflowSignature({ body, headers, secret, now = Date.now() }) {
  const timestamp = singleHeader(headers["x-webflow-timestamp"]);
  const signature = singleHeader(headers["x-webflow-signature"]);
  if (!secret || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > MAX_WEBHOOK_AGE_MS) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}:${JSON.stringify(body)}`)
    .digest("hex");
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifySharedToken({ actual, expected }) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function getCreditorPublicId() {
  const value = process.env.BILLECTA_CREDITOR_PUBLIC_ID || DEFAULT_CREDITOR_PUBLIC_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid Billecta creditor public ID");
  }
  return value;
}

function getBillectaAuthorization() {
  if (process.env.BILLECTA_SECURE_TOKEN) {
    return "SecureToken " +
      Buffer.from(process.env.BILLECTA_SECURE_TOKEN).toString("base64");
  }

  if (process.env.BILLECTA_USERNAME && process.env.BILLECTA_PASSWORD) {
    return "Basic " + Buffer.from(
      `${process.env.BILLECTA_USERNAME}:${process.env.BILLECTA_PASSWORD}`
    ).toString("base64");
  }

  if (process.env.BILLECTA_KEY) {
    return "Basic " + Buffer.from(`${process.env.BILLECTA_KEY}:`).toString("base64");
  }

  return null;
}

export function parseSubmission(body) {
  if (body?.triggerType !== "form_submission") {
    throw new Error("Unexpected trigger type");
  }

  const payload = body?.payload;
  if (!payload || payload.siteId !== WEBFLOW_SITE_ID ||
      payload.name !== WEBFLOW_FORM_NAME || typeof payload.id !== "string" ||
      !payload.id) {
    throw new Error("Unexpected form submission");
  }

  const data = payload.data || {};
  const name = cleanString(data.name ?? data.Name, 200);
  const email = cleanString(data.email ?? data.Email, 254).toLowerCase();
  const ssn = cleanString(data.ssn ?? data.SSN, 20).replace(/[-\s]/g, "");
  const street = cleanString(data.street ?? data.Street, 200);
  const zip = cleanString(data.zip ?? data.Zip, 12).replace(/\s/g, "");
  const city = cleanString(data.city ?? data.City, 100);

  if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error("Invalid name or email");
  }
  if (!/^\d{12}$/.test(ssn)) {
    throw new Error("Invalid Swedish personal identity number format");
  }
  if (!street || !/^\d{5}$/.test(zip) || !city) {
    throw new Error("Invalid address");
  }

  return {
    submissionId: payload.id,
    billectaPayload: {
      creditorPublicId: getCreditorPublicId(),
      name,
      email,
      ssn,
      address: { street, zip, city }
    }
  };
}

function getBillectaBaseUrl() {
  const value = process.env.BILLECTA_API_BASE_URL || BILLECTA_TEST_URL;
  if (![BILLECTA_TEST_URL, BILLECTA_PRODUCTION_URL].includes(value)) {
    throw new Error("Invalid Billecta API base URL");
  }
  return value;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const hasValidSignature = verifyWebflowSignature({
    body: req.body,
    headers: req.headers,
    secret: process.env.WEBFLOW_WEBHOOK_SECRET
  });
  const hasValidSharedToken = verifySharedToken({
    actual: req.query?.token,
    expected: process.env.WEBFLOW_SHARED_TOKEN
  });

  if (!hasValidSignature && !hasValidSharedToken) {
    console.warn("Rejected webhook: invalid signature");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let submission;
  try {
    submission = parseSubmission(req.body);
  } catch (error) {
    console.warn("Rejected webhook: invalid payload", { reason: error.message });
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { submissionId, billectaPayload } = submission;
  const dryRun = process.env.BILLECTA_DRY_RUN !== "false";
  if (dryRun) {
    console.info("Validated webhook in dry-run mode", { submissionId });
    return res.status(200).json({ accepted: true, dryRun: true, submissionId });
  }

  const billectaAuthorization = getBillectaAuthorization();
  if (!billectaAuthorization) {
    console.error("Billecta integration is not configured", { submissionId });
    return res.status(503).json({ error: "Integration unavailable" });
  }

  try {
    const response = await fetch(`${getBillectaBaseUrl()}/v1/debtors/debtor`, {
      method: "POST",
      headers: {
        Authorization: billectaAuthorization,
        "Content-Type": "application/json",
        Accept: "application/json",
        UniqueApiCallId: `wf-${submissionId}`.slice(0, 50)
      },
      body: JSON.stringify(billectaPayload)
    });

    if (!response.ok) {
      console.error("Billecta request failed", { submissionId, status: response.status });
      return res.status(502).json({ error: "Upstream request failed" });
    }

    console.info("Billecta debtor created", { submissionId });
    return res.status(200).json({ success: true, submissionId });
  } catch (error) {
    console.error("Billecta request could not be completed", {
      submissionId,
      reason: error instanceof Error ? error.name : "UnknownError"
    });
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
