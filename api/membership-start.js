import {
  BILLECTA_TEST_URL,
  bankAccountRetrievalPayload,
  billectaFetch,
  createState,
  getBillectaBaseUrl,
  parseJsonBody,
  parseRegistration,
  setCors
} from "../lib/membership.js";

export default async function handler(req, res) {
  if (!setCors(req, res)) return res.status(403).json({ error: "Origin not allowed" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let registration;
  try {
    registration = parseRegistration(parseJsonBody(req.body));
  } catch (error) {
    return res.status(400).json({
      error: error.code === "senior_ineligible" ? error.code : "invalid_registration"
    });
  }

  try {
    const result = await billectaFetch("/v1/bankaccount/initiateretrieval", {
      method: "POST",
      body: JSON.stringify(bankAccountRetrievalPayload(registration))
    });
    if (!result?.SessionToken || !result?.SessionId) {
      throw new Error("Invalid account retrieval response");
    }
    return res.status(200).json({
      sessionToken: result.SessionToken,
      sessionId: result.SessionId,
      state: createState(registration),
      accountLookupBaseUrl: getBillectaBaseUrl() === BILLECTA_TEST_URL
        ? "https://accountlookup.test.billecta.com"
        : "https://accountlookup.billecta.com",
      environment: getBillectaBaseUrl() === BILLECTA_TEST_URL ? "test" : "production"
    });
  } catch (error) {
    console.error("Could not start Billecta account retrieval", {
      status: error.status || 500,
      reason: error.message
    });
    return res.status(502).json({ error: "bankid_start_failed" });
  }
}

