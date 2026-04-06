export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const data = req.body;

  try {
    const response = await fetch("https://api.billecta.com/v1/debtors/debtor", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(process.env.BILLECTA_KEY + ":").toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: data.name,
        email: data.email,
        ssn: data.ssn,
        address: {
          street: data.street,
          zip: data.zip,
          city: data.city
        }
      })
    });
    // test
    const result = await response.json();
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
}
