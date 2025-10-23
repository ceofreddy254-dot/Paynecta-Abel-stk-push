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

// PayNecta credentials
const PAYNECTA_EMAIL = "ceofreddy254@gmail.com";
const PAYNECTA_API_KEY = "hmp_qRLRJKTcVe4BhEQyp7GX5bttJTPzgYUUBU8wPZgO";
const PAYNECTA_CODE = "PNT_109820";

// Receipts file
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://paymenttesting.onrender.com"
  })
);

// Helpers
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

// ✅ 1. Initiate Payment (PayNecta)
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      code: PAYNECTA_CODE,
      mobile_number: formattedPhone,
      amount: Math.round(amount)
    };

    const resp = await axios.post("https://paynecta.co.ke/api/v1/payment/initialize", payload, {
      headers: {
        "X-API-Key": PAYNECTA_API_KEY,
        "X-User-Email": PAYNECTA_EMAIL,
        "Content-Type": "application/json"
      }
    });

    console.log("PayNecta response:", resp.data);

    const receipts = readReceipts();

    if (resp.data.success) {
      const transaction_reference = resp.data.data.transaction_reference;
      const receiptData = {
        reference,
        transaction_id: transaction_reference || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete payment.`,
        timestamp: new Date().toISOString()
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      // ✅ Correct PayNecta status check
      const interval = setInterval(async () => {
        try {
          const statusResp = await axios.get(
            `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${transaction_reference}`,
            {
              headers: {
                "X-API-Key": PAYNECTA_API_KEY,
                "X-User-Email": PAYNECTA_EMAIL
              }
            }
          );

          const payStatus = statusResp.data.data?.status?.toLowerCase();
          console.log(`[${reference}] PayNecta status:`, payStatus);

          let receiptsNow = readReceipts();
          const currentReceipt = receiptsNow[reference];

          if (!currentReceipt) return;

          if (payStatus === "completed" || payStatus === "processing") {
            currentReceipt.status = "processing";
            currentReceipt.transaction_code =
              statusResp.data.data.mpesa_receipt_number || null;
            currentReceipt.status_note =
              "✅ Payment confirmed successfully. Loan processing started.";
            currentReceipt.timestamp = new Date().toISOString();
            writeReceipts(receiptsNow);
            clearInterval(interval);
          } else if (payStatus === "failed" || payStatus === "cancelled") {
            currentReceipt.status = "cancelled";
            currentReceipt.status_note =
              statusResp.data.data.failure_reason || "❌ Payment failed or cancelled.";
            currentReceipt.timestamp = new Date().toISOString();
            writeReceipts(receiptsNow);
            clearInterval(interval);
          }
        } catch (err) {
          console.log(`[${reference}] Status check error:`, err.message);
        }
      }, 15000);

      res.json({ success: true, message: "STK push sent, check your phone", reference, receipt: receiptData });
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
      timestamp: new Date().toISOString()
    };

    let receipts = readReceipts();
    receipts[reference] = errorReceiptData;
    writeReceipts(receipts);

    res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message,
      receipt: errorReceiptData
    });
  }
});

// ✅ 2. Callback (Webhook simulation)
app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);

  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  const status = data.status?.toLowerCase();
  const customerName =
    data.name ||
    [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(" ") ||
    existingReceipt.customer_name ||
    "N/A";

  if (status === "completed") {
    receipts[ref] = {
      ...existingReceipt,
      reference: ref,
      transaction_id: existingReceipt.transaction_id,
      transaction_code: data.mpesa_receipt_number || null,
      status: "processing",
      status_note: `✅ Your payment has been confirmed and loan processing has started.`,
      customer_name: customerName,
      timestamp: new Date().toISOString()
    };
  } else {
    receipts[ref] = {
      ...existingReceipt,
      reference: ref,
      status: "cancelled",
      status_note: data.message || "Payment failed or cancelled.",
      timestamp: new Date().toISOString()
    };
  }

  writeReceipts(receipts);
  res.json({ success: true });
});

// ✅ 3. Fetch receipt
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// ✅ 4. PDF receipt generator
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${receipt.reference}.pdf`);

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
    ["Time", new Date(receipt.timestamp).toLocaleString()]
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

// ✅ 5. Cron (auto release loans)
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

// ✅ Start server
app.listen(PORT, () => console.log(`🚀 PayNecta Server running on port ${PORT}`));
