export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const raw = req.body;
  const data = raw.fields || raw;

  console.log("DATA:", data);

  try {
    const response = await fetch("https://api.billecta.com/v1/debtors/debtor", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(process.env.BILLECTA_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: data.name || data.Name,
        email: data.email || data.Email,
        ssn: data.ssn || data.SSN,
        address: {
          street: data.street || data.Street,
          zip: data.zip || data.Zip,
          city: data.city || data.City
        }
      })
    });

    const result = await response.json();

    console.log("BILLECTA RESPONSE:", result);

    res.status(200).json(result);

  } catch (error) {
    console.error("ERROR:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
}
