import {
  billectaFetch,
  contractInvoicePayload,
  debtorPayload,
  debtorWithAutogiroPayload,
  getCreditorPublicId,
  parseBankAccount,
  parseJsonBody,
  safeBillectaErrorMessage,
  setCors,
  verifyState
} from "../lib/membership.js";

export default async function handler(req, res) {
  if (!setCors(req, res)) return res.status(403).json({ error: "Origin not allowed" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let registration;
  let bankAccount;
  let billectaStage = "customer_lookup";
  try {
    const body = parseJsonBody(req.body);
    registration = verifyState(body.state);
    bankAccount = parseBankAccount(body.bankAccount || {});
  } catch {
    return res.status(400).json({ error: "invalid_completion" });
  }

  const dryRun = process.env.BILLECTA_DRY_RUN !== "false";
  if (dryRun) {
    return res.status(200).json({ accepted: true, dryRun: true });
  }

  try {
    const creditorId = getCreditorPublicId();
    let existing = await billectaFetch(
      `/v1/debtors/debtorsbyorgno/${creditorId}?orgno=${encodeURIComponent(registration.ssn)}` +
      "&countrycode=SE&offset=0&limit=1&sortingfield=Created&asc=false"
    );
    if (!Array.isArray(existing) || existing.length === 0) {
      billectaStage = "customer_create";
      await billectaFetch("/v1/debtors/debtor", {
        method: "POST",
        headers: { UniqueApiCallId: `member-debtor-${registration.nonce}`.slice(0, 50) },
        body: JSON.stringify(debtorPayload(registration))
      });
      billectaStage = "customer_reload";
      existing = await billectaFetch(
        `/v1/debtors/debtorsbyorgno/${creditorId}?orgno=${encodeURIComponent(registration.ssn)}` +
        "&countrycode=SE&offset=0&limit=1&sortingfield=Created&asc=false"
      );
    }
    const debtor = Array.isArray(existing) ? existing[0] : null;
    if (!debtor?.DebtorPublicId) throw new Error("Billecta debtor was not returned");

    billectaStage = "autogiro_update";
    await billectaFetch("/v1/debtors/debtor", {
      method: "PUT",
      headers: { UniqueApiCallId: `member-autogiro-${registration.nonce}`.slice(0, 50) },
      body: JSON.stringify(debtorWithAutogiroPayload(debtor, bankAccount))
    });

    billectaStage = "contract_defaults";
    const defaults = await billectaFetch(`/v1/creditors/defaultactionconfig/${creditorId}`);

    billectaStage = "contract_create";
    const result = await billectaFetch("/v1/contractinvoice/action", {
      method: "POST",
      headers: { UniqueApiCallId: `member-contract-${registration.nonce}`.slice(0, 50) },
      body: JSON.stringify(contractInvoicePayload(
        registration, debtor.DebtorPublicId, defaults || {}
      ))
    });
    console.info("Billecta test membership created", {
      membershipType: registration.membershipType,
      termsVersion: registration.termsVersion
    });
    return res.status(200).json({ success: true, publicId: result?.PublicId || result?.Id || null });
  } catch (error) {
    console.error("Could not create Billecta membership", {
      status: error.status || 500,
      reason: error.message,
      stage: billectaStage,
      upstreamMessage: safeBillectaErrorMessage(error)
    });
    return res.status(502).json({ error: "membership_creation_failed" });
  }
}

