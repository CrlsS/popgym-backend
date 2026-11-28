import crypto from "node:crypto";

export const BILLECTA_TEST_URL = "https://apitest.billecta.com";
export const BILLECTA_PRODUCTION_URL = "https://api.billecta.com";

const PLANS = {
  regular: { amount: 990, label: "Studiomedlemskap" },
  senior: { amount: 490, label: "Senior 65+" }
};

const ALLOWED_ORIGINS = new Set([
  "https://popgym.se",
  "https://www.popgym.se",
  "https://pop-people-of-power.design.webflow.com"
]);

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parseJsonBody(body) {
  if (body && typeof body === "object") return body;
  if (typeof body === "string") return JSON.parse(body);
  return {};
}

export function setCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return !origin || ALLOWED_ORIGINS.has(origin);
}

export function getBillectaBaseUrl() {
  const value = process.env.BILLECTA_API_BASE_URL || BILLECTA_TEST_URL;
  if (![BILLECTA_TEST_URL, BILLECTA_PRODUCTION_URL].includes(value)) {
    throw new Error("Invalid Billecta API base URL");
  }
  if (value === BILLECTA_PRODUCTION_URL &&
      process.env.BILLECTA_ALLOW_PRODUCTION_MEMBERSHIP !== "true") {
    throw new Error("Production membership flow is disabled");
  }
  return value;
}

export function getCreditorPublicId() {
  const value = process.env.BILLECTA_CREDITOR_PUBLIC_ID || "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("Billecta creditor is not configured");
  }
  return value;
}

export function bankAccountRetrievalPayload(registration) {
  const payload = { CreditorPublicId: getCreditorPublicId() };
  // Billecta's Test Bank expects the tester to enter any six-digit test
  // username in the iframe when no personal identity number is pre-supplied.
  if (getBillectaBaseUrl() !== BILLECTA_TEST_URL) {
    payload.PersonalIdNumber = `${registration.ssn.slice(2, 8)}-${registration.ssn.slice(8)}`;
  }
  return payload;
}

export function getBillectaAuthorization() {
  if (process.env.BILLECTA_SECURE_TOKEN) {
    return "SecureToken " + Buffer.from(process.env.BILLECTA_SECURE_TOKEN).toString("base64");
  }
  if (process.env.BILLECTA_USERNAME && process.env.BILLECTA_PASSWORD) {
    return "Basic " + Buffer.from(
      `${process.env.BILLECTA_USERNAME}:${process.env.BILLECTA_PASSWORD}`
    ).toString("base64");
  }
  if (process.env.BILLECTA_KEY) {
    return "Basic " + Buffer.from(`${process.env.BILLECTA_KEY}:`).toString("base64");
  }
  throw new Error("Billecta credentials are not configured");
}

function normalizeSsn(value) {
  const ssn = cleanString(value, 20).replace(/[-+\s]/g, "");
  if (!/^\d{12}$/.test(ssn)) throw new Error("Invalid personal identity number");
  return ssn;
}

function ageFromSsn(ssn, now = new Date()) {
  const year = Number(ssn.slice(0, 4));
  const month = Number(ssn.slice(4, 6));
  const day = Number(ssn.slice(6, 8));
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 ||
      birth.getUTCDate() !== day || birth > now) {
    throw new Error("Invalid personal identity number");
  }
  let age = now.getUTCFullYear() - year;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < month * 100 + day) age -= 1;
  return age;
}

export function parseRegistration(input, now = new Date()) {
  const membershipType = cleanString(input.membershipType, 20);
  const plan = PLANS[membershipType];
  if (!plan) throw new Error("Invalid membership type");
  if (input.termsAccepted !== true) throw new Error("Terms must be accepted");

  const ssn = normalizeSsn(input.ssn);
  if (membershipType === "senior" && ageFromSsn(ssn, now) < 65) {
    const error = new Error("Senior age requirement not met");
    error.code = "senior_ineligible";
    throw error;
  }

  const registration = {
    membershipType,
    amount: plan.amount,
    planLabel: plan.label,
    name: cleanString(input.name, 200),
    email: cleanString(input.email, 254).toLowerCase(),
    phone: cleanString(input.phone, 30),
    ssn,
    street: cleanString(input.street, 200),
    zip: cleanString(input.zip, 12).replace(/\s/g, ""),
    city: cleanString(input.city, 100),
    termsVersion: cleanString(input.termsVersion, 100) || "draft-v1"
  };

  if (!registration.name || !/^\S+@\S+\.\S+$/.test(registration.email) ||
      !registration.phone || !registration.street || !/^\d{5}$/.test(registration.zip) ||
      !registration.city) {
    throw new Error("Required membership information is missing");
  }
  return registration;
}

function stateSecret() {
  const secret = process.env.MEMBERSHIP_STATE_SECRET || process.env.WEBFLOW_SHARED_TOKEN;
  if (!secret || secret.length < 24) throw new Error("Membership state secret is not configured");
  return secret;
}

export function createState(registration, now = Date.now()) {
  const payload = {
    ...registration,
    nonce: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 20 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyState(token, now = Date.now()) {
  if (typeof token !== "string") throw new Error("Invalid membership state");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new Error("Invalid membership state");
  const expected = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid membership state");
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.expiresAt || payload.expiresAt < now) throw new Error("Membership state expired");
  return payload;
}

export function parseBankAccount(input) {
  const clearingNo = cleanString(input.clearingNo, 12).replace(/\D/g, "");
  const accountNo = cleanString(input.accountNo, 30).replace(/\D/g, "");
  const bank = cleanString(input.bankName || input.bank, 100);
  if (clearingNo.length < 4 || accountNo.length < 5 || !bank) {
    throw new Error("Invalid bank account response");
  }
  return { clearingNo, accountNo, bank };
}

export function monthlyAutogiroPayload(registration, bankAccount) {
  const withdrawalDay = Number(process.env.BILLECTA_WITHDRAWAL_DAY || 27);
  if (!Number.isInteger(withdrawalDay) || withdrawalDay < 1 || withdrawalDay > 28) {
    throw new Error("Invalid withdrawal day");
  }
  return {
    CreditorPublicId: getCreditorPublicId(),
    Name: registration.name,
    Address: registration.street,
    Address2: null,
    ZipCode: registration.zip,
    City: registration.city,
    Email: registration.email,
    Phone: registration.phone,
    SSN: `${registration.ssn.slice(0, 8)}-${registration.ssn.slice(8)}`,
    ClearingNumber: bankAccount.clearingNo,
    AccountNumber: bankAccount.accountNo,
    Bank: bankAccount.bank,
    Amount: registration.amount,
    WithdrawalDay: withdrawalDay,
    EndDate: null,
    StartDate: null,
    EnableAutomaticReminder: false,
    EnableAutomaticDebtCollection: false
  };
}

export function debtorPayload(registration) {
  return {
    CreditorPublicId: getCreditorPublicId(),
    Name: registration.name,
    Address: registration.street,
    ZipCode: registration.zip,
    City: registration.city,
    CountryCode: "SE",
    Phone: registration.phone,
    Email: registration.email,
    ContactName: registration.name,
    ContactEmail: registration.email,
    OrgNo: registration.ssn,
    IsActive: true,
    ProtectedIdentity: false,
    UseProtectedMailDelivery: false,
    DebtorType: "Private"
  };
}

export function debtorWithAutogiroPayload(debtor, bankAccount) {
  return {
    ...debtor,
    Autogiro: {
      Active: true,
      AccountNo: bankAccount.accountNo,
      ClearingNo: bankAccount.clearingNo,
      Stage: "Approved",
      PayerNumber: debtor.OrgNo || null,
      PaymentServiceSupplier: bankAccount.bank,
      AutogiroFirstWithdrawalDate: null
    }
  };
}

function sek(value) {
  return { CurrencyCode: "SEK", Value: Math.round(value * 100) };
}

export function contractInvoicePayload(registration, debtorPublicId, defaults, now = new Date()) {
  const withdrawalDay = Number(process.env.BILLECTA_WITHDRAWAL_DAY || 27);
  const start = now.toISOString();
  const contractSuffix = registration.nonce?.slice(0, 12) ||
    crypto.createHash("sha256").update(registration.ssn).digest("hex").slice(0, 12);
  return {
    CreditorPublicId: getCreditorPublicId(),
    DebtorPublicId: debtorPublicId,
    PaymentTermsInDays: defaults.InvoicePaymentTermsInDays ?? defaults.PaymentTermsInDays ?? 0,
    Records: [{
      ProductPublicId: null,
      SequenceNo: 1,
      Units: "st",
      ArticleDescription: registration.membershipType === "senior" ?
        "POP Gym Senior 65+" : "POP Gym Studiomedlemskap",
      ArticleNumber: registration.membershipType === "senior" ? "POP-SENIOR" : "POP-STUDIO",
      Quantity: 1,
      UnitPrice: sek(registration.amount),
      DiscountPercentage: 0,
      DiscountType: "Percentage",
      VAT: 6,
      RotRutActivated: false,
      RotRutHours: 0,
      RotRutType: "Construction",
      RecordType: "Standard",
      VatIsIncluded: true,
      Hidden: false,
      InvoicedFrom: null,
      InvoicedTo: null,
      PostInvoice: false,
      AdvanceInvoice: false
    }],
    InterestTermsInDays: defaults.InterestTermsInDays ?? 0,
    InterestPercentage: defaults.InterestPercentage ?? 0,
    InterestType: defaults.InterestType || "NoInterest",
    InterestStartInDaysAfterDueDate: defaults.InterestStartInDaysAfterDueDate ?? 0,
    OurReference: defaults.OurReference || null,
    DeliveryMethod: "Manually",
    CommunicationLanguage: defaults.CommunicationLanguage || "SV",
    AutoAttest: false,
    AutoMerge: false,
    PayLastDayOfMonth: false,
    RecurrenceDetails: {
      RecurrenceInterval: "Monthly",
      MonthlyRecurrence: { RecurOnDayInMonth: withdrawalDay, RecurMonthInterval: 1 },
      Start: start,
      NoEndDate: true,
      End: null
    },
    ContractNumber: `POP-${contractSuffix}`,
    InvoicePeriod: "Current",
    InvoicePeriodMonthsOffset: 0,
    InvoiceFeeVat: 0,
    FreightFeeVat: 0,
    HideDateOnPeriodisedRecords: false,
    AutogiroWithdrawalEnabled: true,
    CreditCardWithdrawalEnabled: false,
    SwishWithdrawalEnabled: false,
    SendByMailIfEmailNotViewedInDays: null,
    GenerateInvoicesOfActionType: "InvoiceAction",
    PdfTemplateId: null
  };
}

export async function billectaFetch(path, options = {}) {
  const response = await fetch(`${getBillectaBaseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: getBillectaAuthorization(),
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error("Billecta request failed");
    error.status = response.status;
    error.upstream = data;
    error.upstreamMessage = response.headers.get("ErrorMessage") ||
      data?.ErrorMessage || data?.errorMessage || data?.Message || data?.message || null;
    throw error;
  }
  return data;
}

export function safeBillectaErrorMessage(error) {
  const value = typeof error?.upstreamMessage === "string" ? error.upstreamMessage.trim() : "";
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\d{6}|\d{8})[-+]?\d{4}\b/g, "[personnummer]")
    .replace(/\b\d{10,}\b/g, "[nummer]")
    .slice(0, 300);
}

