(function () {
  "use strict";

  var API_ROOT = "https://popgym-backend.vercel.app/api";
  var form = document.querySelector('form[data-membership-registration="draft"]');
  if (!form || !window.Billecta) return;

  var statusRegion = form.querySelector('[data-member-status-region="true"]');
  var states = statusRegion ? statusRegion.querySelectorAll("[data-member-state]") : [];
  var client = null;

  function showState(name) {
    if (!statusRegion) return;
    statusRegion.style.display = "block";
    states.forEach(function (el) {
      el.style.display = el.getAttribute("data-member-state") === name ? "block" : "none";
    });
  }

  function value(name) {
    var field = form.elements[name];
    return field && typeof field.value === "string" ? field.value.trim() : "";
  }

  function registration(button) {
    var terms = form.elements.terms;
    return {
      membershipType: button.getAttribute("data-membership-type"),
      name: value("full_name"),
      phone: value("phone"),
      email: value("email"),
      ssn: value("ssn"),
      street: value("street"),
      zip: value("zip"),
      city: value("city"),
      termsAccepted: Boolean(terms && terms.checked),
      termsVersion: (terms && terms.getAttribute("data-terms-version")) || "draft-v1"
    };
  }

  async function post(path, body) {
    var response = await fetch(API_ROOT + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || "request_failed");
      error.code = data.error;
      throw error;
    }
    return data;
  }

  function iframeTarget() {
    var target = document.getElementById("bank-account-iframe");
    if (!target) {
      target = document.createElement("div");
      target.id = "bank-account-iframe";
      target.style.margin = "24px auto 0";
      target.style.maxWidth = "559px";
      statusRegion.appendChild(target);
    }
    target.innerHTML = "";
    return target;
  }

  async function start(event) {
    event.preventDefault();
    var button = event.currentTarget;
    var payload = registration(button);
    if (!payload.termsAccepted) return;
    button.disabled = true;
    showState("preparing");

    try {
      var session = await post("/membership-start", payload);
      iframeTarget();
      showState("open");
      client = new window.Billecta(session.sessionToken, session.sessionId, {
        baseUrl: session.accountLookupBaseUrl
      });
      client.start({
        selector: "#bank-account-iframe",
        width: "100%",
        height: "600px",
        colorTheme: "dark",
        onSuccessful: async function (bankAccount) {
          showState("pending");
          try {
            await post("/membership-complete", { state: session.state, bankAccount: bankAccount });
            showState("complete");
          } catch (error) {
            showState(error.code === "senior_ineligible" ? "senior_ineligible" : "error");
            button.disabled = false;
          }
        },
        onAborted: function () {
          showState("error");
          button.disabled = false;
        },
        onFailed: function () {
          showState("error");
          button.disabled = false;
        }
      });
    } catch (error) {
      showState(error.code === "senior_ineligible" ? "senior_ineligible" : "error");
      button.disabled = false;
    }
  }

  form.addEventListener("submit", function (event) { event.preventDefault(); });
  form.querySelectorAll('[data-integration-action="start-bankid"]').forEach(function (button) {
    button.addEventListener("click", start);
  });
})();

