const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 PayNecta credentials
const PAYNECTA_EMAIL = "ceofreddy254@gmail.com";
const PAYNECTA_API_KEY = "hmp_frCOR914YZjJiOoTsNiF6m5AXka5TVgtTKyeeoTO";
const PAYNECTA_CODE = "PNT_366813";

// File to store receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://swiftcapitalportal.onrender.com",
  })
);

// 🧾 Helpers
function readReceipts() {
  try {
    if (!fs.existsSync(receiptsFile)) return {};
    return JSON.parse(fs.readFileSync(receiptsFile));
  } catch {
    return {};
  }
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// ✅ 1. Initiate Payment (STK Push via PayNecta)
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      code: PAYNECTA_CODE,
      mobile_number: formattedPhone,
      amount: Math.round(amount),
    };

    const resp = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      payload,
      {
        headers: {
          "X-API-Key": PAYNECTA_API_KEY,
          "X-User-Email": PAYNECTA_EMAIL,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("PayNecta response:", resp.data);

    const receipts = readReceipts();

    if (resp.data.success) {
      const receiptData = {
        reference,
        transaction_id: resp.data.data.transaction_reference || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete payment.`,
        timestamp: new Date().toISOString(),
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({
        success: true,
        message: "STK push sent, check your phone",
        reference,
        receipt: receiptData,
      });
    } else {
      throw new Error(resp.data.message || "Failed to initiate payment");
    }
  } catch (err) {
    console.error("Payment initiation error:", err.response?.data || err.message);

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceiptData = {
      reference,
      transaction_id: null,
      transaction_code: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      customer_name: "N/A",
      status: "error",
      status_note: "Payment initiation failed. Please try again later.",
      timestamp: new Date().toISOString(),
    };

    let receipts = readReceipts();
    receipts[reference] = errorReceiptData;
    writeReceipts(receipts);

    res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message,
      receipt: errorReceiptData,
    });
  }
});

// ✅ 2. PayNecta Webhook (Real Callback)
app.post("/paynecta/webhook", (req, res) => {
  try {
    const signature = req.headers["x-api-key"];
    const email = req.headers["x-user-email"];

    // Verify authenticity of the webhook
    if (signature !== PAYNECTA_API_KEY || email !== PAYNECTA_EMAIL) {
      console.log("❌ Unauthorized webhook attempt detected");
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const data = req.body;
    console.log("✅ PayNecta Webhook received:", data);

    // Example webhook data:
    // {
    //   "success": true,
    //   "status": "completed",
    //   "amount": 100,
    //   "transaction_reference": "ABCP20241023123456ABCD",
    //   "mpesa_receipt": "QER1234XYZ",
    //   "phone": "254700000000"
    // }

    const ref = data.transaction_reference;
    const receipts = readReceipts();
    const existingReceipt = Object.values(receipts).find(
      (r) => r.transaction_id === ref
    );

    if (!existingReceipt) {
      console.log("⚠️ Unknown transaction reference in webhook:", ref);
      return res.status(404).json({ success: false, message: "Unknown reference" });
    }

    const updated = { ...existingReceipt };
    updated.transaction_code = data.mpesa_receipt || existingReceipt.transaction_code;

    if (data.status === "completed" || data.success === true) {
      updated.status = "processing";
      updated.status_note =
        "✅ Payment confirmed and verified. Loan disbursement in progress.";
    } else {
      updated.status = "cancelled";
      updated.status_note = data.message || "Payment failed or cancelled.";
    }

    updated.timestamp = new Date().toISOString();
    receipts[existingReceipt.reference] = updated;
    writeReceipts(receipts);

    res.json({ success: true, message: "Webhook processed successfully" });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ success: false, message: "Webhook error" });
  }
});

// ✅ 3. Fetch receipt
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// ✅ 4. PDF receipt
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

// ✅ PDF generator
function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=receipt-${receipt.reference}.pdf`
  );

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let headerColor = "#2196F3";
  let watermarkText = "";
  let watermarkColor = "green";

  switch (receipt.status) {
    case "success":
      watermarkText = "PAID";
      break;
    case "cancelled":
    case "error":
      headerColor = "#f44336";
      watermarkText = "FAILED";
      watermarkColor = "red";
      break;
    case "pending":
      headerColor = "#ff9800";
      watermarkText = "PENDING";
      watermarkColor = "gray";
      break;
    case "processing":
      watermarkText = "PROCESSING";
      break;
    case "loan_released":
      headerColor = "#4caf50";
      watermarkText = "RELEASED";
      break;
  }

  doc.rect(0, 0, doc.page.width, 80).fill(headerColor);
  doc.fillColor("white").fontSize(24).text("⚡ SWIFTLOAN KENYA RECEIPT", 50, 25);

  doc.moveDown(3).fillColor("black").fontSize(14).text("Receipt Details", { underline: true });
  doc.moveDown();

  const details = [
    ["Reference", receipt.reference],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["Transaction Code", receipt.transaction_code || "N/A"],
    ["Fee Amount", `KSH ${receipt.amount}`],
    ["Loan Amount", `KSH ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Customer Name", receipt.customer_name],
    ["Status", receipt.status.toUpperCase()],
    ["Time", new Date(receipt.timestamp).toLocaleString()],
  ];

  details.forEach(([k, v]) => doc.fontSize(12).text(`${k}: ${v}`));

  if (receipt.status_note) {
    doc.moveDown().fontSize(12).fillColor("#555").text("Note:").moveDown(0.5).text(receipt.status_note);
  }

  if (watermarkText) {
    doc
      .fontSize(60)
      .fillColor(watermarkColor)
      .opacity(0.2)
      .rotate(-30, { origin: [300, 400] })
      .text(watermarkText, 150, 400)
      .rotate(30, { origin: [300, 400] })
      .opacity(1);
  }

  doc.end();
}

// ✅ 5. Cron job — release loans after 24 hours
cron.schedule("*/5 * * * *", () => {
  let receipts = readReceipts();
  const now = Date.now();
  for (let ref in receipts) {
    const r = receipts[ref];
    if (r.status === "processing") {
      const releaseTime = new Date(r.timestamp).getTime() + 24 * 60 * 60 * 1000;
      if (now >= releaseTime) {
        r.status = "loan_released";
        r.status_note = "Loan has been released to your account.";
        console.log(`✅ Loan released for ${ref}`);
      }
    }
  }
  writeReceipts(receipts);
});

// ✅ Start Server
app.listen(PORT, () => console.log(`🚀 PayNecta Server running on port ${PORT}`));
