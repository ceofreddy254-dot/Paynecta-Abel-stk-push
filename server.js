/**
 * server.js — Paycenter backend for PayNecta STK Push integration
 * Restricted CORS: only https://swiftduty.onrender.com allowed
 */

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import axios from "axios";
import PDFDocument from "pdfkit";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();

// ✅ Strict CORS — only allow your frontend
app.use(
  cors({
    origin: "https://paymenttesting.onrender.com",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-API-Key", "X-User-Email"],
    credentials: true
  })
);

app.use(bodyParser.json());

// Config
const PORT = process.env.PORT || 3000;
const PAYNECTA_BASE = process.env.PAYNECTA_BASE_URL || "https://paynecta.co.ke";
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_USER_EMAIL = process.env.PAYNECTA_USER_EMAIL;

if (!PAYNECTA_API_KEY || !PAYNECTA_USER_EMAIL) {
  console.warn("⚠️ PAYNECTA_API_KEY or PAYNECTA_USER_EMAIL missing in .env");
}

// In-memory transactions store (replace with DB in production)
const transactions = {};

/* -------------------- Helpers -------------------- */
function createTransactionEntry({ code, mobile_number, amount, mpesaCheckoutRequestID = null }) {
  const transaction_reference = `PC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tx = {
    transaction_reference,
    payment_link_code: code,
    amount,
    mobile_number,
    created_at: new Date().toISOString(),
    status: "initialized",
    mpesa: {
      CheckoutRequestID: mpesaCheckoutRequestID,
      MpesaReceiptNumber: null,
      TransactionDate: null,
      TransactionCode: null,
      PaymentName: null,
      error_code: null,
      error_message: null
    },
    logs: []
  };
  transactions[transaction_reference] = tx;
  return tx;
}

function updateTransaction(ref, patch) {
  const tx = transactions[ref];
  if (!tx) return null;
  Object.assign(tx, patch);
  tx.updated_at = new Date().toISOString();
  return tx;
}

const MPESA_ERROR_MAP = {
  INSUFFICIENT_FUNDS: "Insufficient funds in customer account.",
  USER_CANCELLED: "Customer cancelled the transaction on their phone.",
  SYSTEM_BUSY: "M-Pesa system busy — please try again later.",
  TIMED_OUT: "Transaction timed out — no response from customer.",
  DUPLICATE_REQUEST: "Duplicate checkout request.",
  INVALID_PHONE_NUMBER: "Invalid or unsupported Safaricom number.",
  RESOURCES_NOT_FOUND: "Requested resource not found.",
  UNKNOWN_ERROR: "Unknown error occurred."
};

function mapMpesaError(codeOrMessage) {
  if (!codeOrMessage) return null;
  if (MPESA_ERROR_MAP[codeOrMessage]) return MPESA_ERROR_MAP[codeOrMessage];
  const lower = String(codeOrMessage).toLowerCase();
  if (lower.includes("insufficient")) return MPESA_ERROR_MAP.INSUFFICIENT_FUNDS;
  if (lower.includes("cancel")) return MPESA_ERROR_MAP.USER_CANCELLED;
  if (lower.includes("timeout")) return MPESA_ERROR_MAP.TIMED_OUT;
  return MPESA_ERROR_MAP.UNKNOWN_ERROR;
}

async function paynectaRequest(method, path, data = null, params = null) {
  const url = `${PAYNECTA_BASE.replace(/\/$/, "")}/api/v1${path}`;
  const headers = {
    "X-API-Key": PAYNECTA_API_KEY || "",
    "X-User-Email": PAYNECTA_USER_EMAIL || "",
    "Content-Type": "application/json"
  };
  try {
    const resp = await axios({ method, url, headers, data, params, timeout: 20000 });
    return resp.data;
  } catch (err) {
    if (err.response && err.response.data) {
      throw { status: err.response.status, data: err.response.data };
    }
    throw { status: 500, data: { success: false, message: err.message } };
  }
}

/* -------------------- API Routes -------------------- */

// ✅ Verify authentication
app.get("/api/auth/verify", async (req, res) => {
  try {
    const result = await paynectaRequest("get", "/auth/verify");
    res.json({ success: true, message: "PayNecta authentication successful", data: result.data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: "Auth verification failed", error: err.data });
  }
});

// ✅ Initialize Payment (STK Push)
app.post("/api/payment/initialize", async (req, res) => {
  const { code, mobile_number, amount } = req.body;
  if (!code || !mobile_number || !amount)
    return res.status(400).json({ success: false, message: "Missing required fields" });

  if (!/^(2547|07|01)\d{8}$/.test(mobile_number))
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: { mobile_number: ["The mobile number must be a valid Safaricom number"] }
    });

  const tx = createTransactionEntry({ code, mobile_number, amount });

  try {
    const paynectaResp = await paynectaRequest("post", "/payment/initialize", { code, mobile_number, amount });
    const remoteData = paynectaResp.data || {};

    updateTransaction(tx.transaction_reference, {
      status: "pending",
      mpesa: {
        ...tx.mpesa,
        CheckoutRequestID: remoteData.CheckoutRequestID,
        remote_transaction_reference: remoteData.transaction_reference
      },
      logs: [...tx.logs, { at: new Date().toISOString(), note: "Initialized STK Push", remoteData }]
    });

    res.json({
      success: true,
      message: "Payment initiated successfully. Check your phone for the STK push.",
      data: {
        local_transaction_reference: tx.transaction_reference,
        paynecta_transaction_reference: remoteData.transaction_reference,
        CheckoutRequestID: remoteData.CheckoutRequestID
      }
    });
  } catch (err) {
    const errorMsg = err.data?.message || err.message || "Initialization failed";
    updateTransaction(tx.transaction_reference, {
      status: "error",
      mpesa: { ...tx.mpesa, error_message: errorMsg },
      logs: [...tx.logs, { at: new Date().toISOString(), note: "Initialization failed", error: err.data }]
    });
    res.status(err.status || 500).json({ success: false, message: "Payment initialization failed", error: err.data });
  }
});

// ✅ Query local transaction
app.get("/api/payment/status", (req, res) => {
  const { transaction_reference } = req.query;
  if (!transaction_reference)
    return res.status(400).json({ success: false, message: "transaction_reference required" });
  const tx = transactions[transaction_reference];
  if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });
  res.json({ success: true, data: tx });
});

// ✅ Generate PDF receipt
app.get("/api/payment/:ref/receipt", (req, res) => {
  const ref = req.params.ref;
  const tx = transactions[ref];
  if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });

  const doc = new PDFDocument({ margin: 40 });
  const filename = `receipt_${ref}.pdf`;
  res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-type", "application/pdf");

  doc.fontSize(20).text("PayCenter - Payment Receipt", { align: "center" }).moveDown();
  doc.fontSize(12).text(`Transaction Reference: ${tx.transaction_reference}`);
  doc.text(`Payment Link Code: ${tx.payment_link_code || "N/A"}`);
  doc.text(`Amount (KES): ${tx.amount}`);
  doc.text(`Mobile Number: ${tx.mobile_number}`);
  doc.text(`Status: ${tx.status}`);
  doc.text(`Created At: ${tx.created_at}`);
  if (tx.updated_at) doc.text(`Updated At: ${tx.updated_at}`);
  doc.moveDown();

  doc.text("M-Pesa Details:", { underline: true });
  doc.text(`CheckoutRequestID: ${tx.mpesa.CheckoutRequestID || "N/A"}`);
  doc.text(`Mpesa Receipt Number: ${tx.mpesa.MpesaReceiptNumber || "N/A"}`);
  doc.text(`Transaction Code: ${tx.mpesa.TransactionCode || "N/A"}`);
  doc.text(`Payment Name: ${tx.mpesa.PaymentName || "N/A"}`);
  doc.text(`Transaction Date: ${tx.mpesa.TransactionDate || "N/A"}`);

  if (tx.mpesa.error_message) {
    doc.moveDown();
    doc.fillColor("red").text("Error:", { underline: true });
    doc.fillColor("black").text(`${tx.mpesa.error_message}`);
  }

  doc.end();
  doc.pipe(res);
});

// ✅ Webhook (PayNecta → backend)
app.post("/api/webhook/mpesa", (req, res) => {
  const body = req.body || {};
  const { CheckoutRequestID, transaction_reference: remoteRef, status, mpesa } = body;

  let tx =
    Object.values(transactions).find(
      t =>
        t.mpesa.CheckoutRequestID === CheckoutRequestID ||
        t.mpesa.remote_transaction_reference === remoteRef ||
        t.transaction_reference === remoteRef
    ) || null;

  if (!tx && mpesa?.PhoneNumber) {
    tx = Object.values(transactions).find(
      t => t.mobile_number === mpesa.PhoneNumber && Number(t.amount) === Number(mpesa.Amount)
    );
  }

  if (!tx) {
    const newTx = createTransactionEntry({
      code: null,
      mobile_number: mpesa?.PhoneNumber || "unknown",
      amount: mpesa?.Amount || 0,
      mpesaCheckoutRequestID: CheckoutRequestID
    });
    tx = newTx;
  }

  const newFields = {};
  if (mpesa) {
    newFields.mpesa = {
      ...tx.mpesa,
      MpesaReceiptNumber: mpesa.MpesaReceiptNumber || tx.mpesa.MpesaReceiptNumber,
      TransactionDate: mpesa.TransactionDate || tx.mpesa.TransactionDate,
      TransactionCode: mpesa.TransactionCode || tx.mpesa.TransactionCode,
      PaymentName: mpesa.PaymentName || tx.mpesa.PaymentName
    };
  }

  let mappedStatus = tx.status;
  if (status) {
    const s = status.toLowerCase();
    if (["success", "completed", "paid"].includes(s)) mappedStatus = "success";
    else if (["failed", "error"].includes(s)) mappedStatus = "failed";
    else mappedStatus = s;
  }

  if (mpesa?.error_code || mpesa?.error_message || mpesa?.ResultDesc) {
    const code = mpesa.error_code || null;
    const message = mpesa.error_message || mpesa.ResultDesc || null;
    newFields.mpesa = {
      ...newFields.mpesa,
      error_code: code,
      error_message: mapMpesaError(code) || message
    };
    mappedStatus = "failed";
  }

  newFields.status = mappedStatus;
  newFields.logs = [...(tx.logs || []), { at: new Date().toISOString(), note: "Webhook processed", body }];
  updateTransaction(tx.transaction_reference, newFields);

  res.json({ success: true, message: "Webhook processed" });
});

// ✅ List all (debug)
app.get("/api/transactions", (req, res) => {
  res.json({ success: true, data: Object.values(transactions) });
});

// Fallback
app.use((req, res) => res.status(404).json({ success: false, message: "Not found" }));

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 PayCenter PayNecta STK backend running on port ${PORT}`);
  console.log(`🔒 Allowed origin: https://https://paymenttesting.onrender.com`);
  console.log(`🌍 PAYNECTA_BASE: ${PAYNECTA_BASE}`);
});
