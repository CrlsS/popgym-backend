export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 🔥 Hämta rätt data från Webflow
    const raw = req.body;
    const data = raw?.payload?.data || raw?.fields || raw;

    console.log("INCOMING DATA:", data);

    // 🔐 Kolla att API key finns
    if (!process.env.BILLECTA_KEY) {
      console.error("Missing BILLECTA_KEY");
      return res.status(500).json({ error: "Missing API key" });
    }

    // 🧾 Bygg payload till Billecta
    const billectaPayload = {
      name: data.name || data.Name,
      email: data.email || data.Email,
      ssn: data.ssn || data.SSN,
      address: {
        street: data.street || data.Street,
        zip: data.zip || data.Zip,
        city: data.city || data.City
      }
    };

    console.log("SENDING TO BILLECTA:", billectaPayload);

    // 📡 Skicka till Billecta
    const response = await fetch("https://api.billecta.com/v1/debtors/debtor", {
      method: "POST",
      headers: {
        "Authorization":
          "Basic " +
          Buffer.from(process.env.BILLECTA_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(billectaPayload)
    });

    // 🔍 Läs response säkert
    const text = await response.text();

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }

    console.log("BILLECTA RESPONSE:", result);

    // ❌ Om Billecta returnerar fel
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Billecta error",
        details: result
      });
    }

    // ✅ Success
    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
}
