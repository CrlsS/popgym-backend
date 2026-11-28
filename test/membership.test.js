import assert from "node:assert/strict";
import test from "node:test";

import {
  bankAccountRetrievalPayload,
  contractInvoicePayload,
  createState,
  debtorPayload,
  debtorWithAutogiroPayload,
  monthlyAutogiroPayload,
  parseBankAccount,
  parseRegistration,
  safeBillectaErrorMessage,
  verifyState
} from "../lib/membership.js";

function validRegistration() {
  return {
    membershipType: "regular",
    name: "Test Person",
    email: "test@example.invalid",
    phone: "0701234567",
    ssn: "199001011234",
    street: "Testgatan 1",
    zip: "123 45",
    city: "Teststad",
    termsAccepted: true,
    termsVersion: "draft-v1"
  };
}

test("validates a studio membership", () => {
  const result = parseRegistration(validRegistration());
  assert.equal(result.amount, 990);
  assert.equal(result.membershipType, "regular");
  assert.equal(result.zip, "12345");
});

test("rejects an underage senior membership", () => {
  assert.throws(() => parseRegistration({
    ...validRegistration(), membershipType: "senior"
  }, new Date("2026-11-27T12:00:00Z")), /Senior age/);
});

test("accepts an eligible senior membership", () => {
  const result = parseRegistration({
    ...validRegistration(), membershipType: "senior", ssn: "195001011234"
  }, new Date("2026-11-27T12:00:00Z"));
  assert.equal(result.amount, 490);
});

test("signs and verifies short-lived membership state", () => {
  process.env.MEMBERSHIP_STATE_SECRET = "a-safe-local-secret-with-enough-length";
  const state = createState(parseRegistration(validRegistration()), 1000);
  const result = verifyState(state, 2000);
  assert.equal(result.email, "test@example.invalid");
  assert.ok(result.nonce);
});

test("rejects tampered membership state", () => {
  process.env.MEMBERSHIP_STATE_SECRET = "a-safe-local-secret-with-enough-length";
  const state = createState(parseRegistration(validRegistration()), 1000);
  assert.throws(() => verifyState(state + "x", 2000), /Invalid membership state/);
});

test("normalizes a bank account response", () => {
  assert.deepEqual(parseBankAccount({
    clearingNo: "1234-5", accountNo: "12 345 678", bankName: "Testbanken"
  }), { clearingNo: "12345", accountNo: "12345678", bank: "Testbanken" });
});

test("omits personal identity number for Billecta Test Bank", () => {
  process.env.BILLECTA_API_BASE_URL = "https://apitest.billecta.com";
  process.env.BILLECTA_CREDITOR_PUBLIC_ID = "11111111-1111-4111-8111-111111111111";
  const payload = bankAccountRetrievalPayload(parseRegistration(validRegistration()));
  assert.deepEqual(payload, {
    CreditorPublicId: "11111111-1111-4111-8111-111111111111"
  });
});

test("builds Billecta monthly autogiro payload", () => {
  process.env.BILLECTA_CREDITOR_PUBLIC_ID = "11111111-1111-4111-8111-111111111111";
  const payload = monthlyAutogiroPayload(
    parseRegistration(validRegistration()),
    parseBankAccount({ clearingNo: "1234", accountNo: "12345678", bank: "Testbanken" })
  );
  assert.equal(payload.Amount, 990);
  assert.equal(payload.SSN, "19900101-1234");
  assert.equal(payload.EnableAutomaticDebtCollection, false);
  assert.equal(payload.DebtorExternalId, undefined);
});

test("builds a Billecta debtor before adding the membership contract", () => {
  process.env.BILLECTA_CREDITOR_PUBLIC_ID = "11111111-1111-4111-8111-111111111111";
  const payload = debtorPayload(parseRegistration(validRegistration()));
  assert.equal(payload.OrgNo, "199001011234");
  assert.equal(payload.DebtorType, "Private");
  assert.equal(payload.Autogiro, undefined);
});

test("adds approved autogiro details to an existing Billecta debtor", () => {
  const payload = debtorWithAutogiroPayload(
    { DebtorPublicId: "debtor-1", OrgNo: "199001011234", Name: "Test Person" },
    parseBankAccount({ clearingNo: "1234", accountNo: "12345678", bank: "Testbanken" })
  );
  assert.equal(payload.DebtorPublicId, "debtor-1");
  assert.equal(payload.Autogiro.Stage, "Approved");
  assert.equal(payload.Autogiro.AccountNo, "12345678");
});

test("builds a safe draft monthly contract using the debtor public id", () => {
  process.env.BILLECTA_CREDITOR_PUBLIC_ID = "11111111-1111-4111-8111-111111111111";
  const payload = contractInvoicePayload(
    parseRegistration(validRegistration()),
    "22222222-2222-4222-8222-222222222222",
    { InvoicePaymentTermsInDays: 10, InterestType: "NoInterest" },
    new Date("2026-11-27T12:00:00Z")
  );
  assert.equal(payload.DebtorPublicId, "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.Records[0].UnitPrice.Value, 99000);
  assert.equal(payload.Records[0].RotRutActivated, false);
  assert.notEqual(payload.Records[0].RotRutType, "Unknown");
  assert.equal(payload.RecurrenceDetails.RecurrenceInterval, "Monthly");
  assert.equal(payload.AutogiroWithdrawalEnabled, true);
  assert.equal(payload.AutoAttest, false);
  assert.equal(payload.DeliveryMethod, "Manually");
});

test("redacts personal details from Billecta errors", () => {
  const message = safeBillectaErrorMessage({
    upstreamMessage: "Invalid 19900101-1234 for test@example.com account 123456789012"
  });
  assert.equal(message, "Invalid [personnummer] for [email] account [personnummer]");
});

