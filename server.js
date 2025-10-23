import express from "express";
import axios from "axios";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";

dotenv.config();
const app = express();

app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://paymenttesting.onrender.com", // ✅ frontend origin only
  })
);

// Constants
const PAYNECTA_BASE_URL = "https://paynecta.co.ke/api/v1";
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_CODE = "PNT_109820"; // ✅ linked payment code

// Test route
app.get("/", (req, res) => {
  res.send("✅ SwiftPay STK Backend Active");
});

// Initialize STK Push
app.post("/api/initiate-stk", async (req, res) => {
  try {
    const { phone, amount, code } = req.body;

    if (!phone || !amount)
      return res.status(400).json({ message: "Phone and amount are required" });

    // Validate code match
    if (code !== PAYNECTA_CODE)
      return res.status(400).json({ message: "Invalid payment link code" });

    const payload = {
      phone,
      amount,
      code: PAYNECTA_CODE,
      callback_url: "https://abels-test-stk-push.onrender.com/api/webhook",
    };

    const headers = {
      "x-api-key": PAYNECTA_API_KEY,
      "x-api-email": PAYNECTA_EMAIL,
    };

    const response = await axios.post(`${PAYNECTA_BASE_URL}/payments/stk`, payload, { headers });
    res.json(response.data);
  } catch (error) {
    console.error("STK Error:", error.response?.data || error.message);
    res.status(500).json({
      message: error.response?.data?.message || "Failed to initiate STK push",
    });
  }
});

// Webhook (called by PayNecta)
app.post("/api/webhook", (req, res) => {
  try {
    const data = req.body;
    console.log("📩 Webhook Received:", data);

    if (data.status === "success") {
      const pdf = new PDFDocument();
      pdf.text(`Payment Receipt - SwiftPay`, { align: "center" });
      pdf.moveDown();
      pdf.text(`Amount: KES ${data.amount}`);
      pdf.text(`Phone: ${data.phone}`);
      pdf.text(`Reference: ${data.reference}`);
      pdf.text(`Status: ${data.status}`);
      pdf.end();
    }

    res.status(200).json({ message: "Webhook processed" });
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).json({ message: "Webhook handling failed" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
