/**
 * server.js — Paycenter backend for PayNecta STK Push integration
 *
 * Features:
 * - /api/auth/verify          -> Verify API credentials against PayNecta
 * - /api/payment/initialize   -> Initialize an M-Pesa STK Push (calls PayNecta)
 * - /api/payment/status       -> Query local transaction status by transaction_reference
 * - /api/payment/:ref/receipt -> Generate PDF receipt for the transaction (download)
 * - /api/webhook/mpesa        -> Webhook endpoint to receive payment callbacks from PayNecta
 *
 * Notes:
 * - Uses environment variables for X-API-Key and X-User-Email
 * - In-memory transaction store (replace with DB for production)
 * - Adds detailed fields required: reference numbers, transaction codes, timestamps, mpesa codes, statuses, mpesa error mapping
 *
 * Environment (.env) variables required:
 * - PAYNECTA_API_KEY
 * - PAYNECTA_USER_EMAIL
 * - PAYNECTA_BASE_URL  (default: https://paynecta.co.ke)
 * - PORT (optional)
 *
 * Run:
 * npm install
 * create .env file
 * npm start
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
app.use(cors());
app.use(bodyParser.json());

// Config
const PORT = process.env.PORT || 3000;
const PAYNECTA_BASE = process.env.PAYNECTA_BASE_URL || "https://paynecta.co.ke";
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_USER_EMAIL = process.env.PAYNECTA_USER_EMAIL;

if (!PAYNECTA_API_KEY || !PAYNECTA_USER_EMAIL) {
  console.warn("WARNING: PAYNECTA_API_KEY and/or PAYNECTA_USER_EMAIL not set in environment variables.");
  console.warn("Set PAYNECTA_API_KEY and PAYNECTA_USER_EMAIL in a .env file for full functionality.");
}

// In-memory transactions store (for demo/proof-of-concept)
// Replace with persistent DB in production.
const transactions = {};

/**
 * Helper: add transaction to store
 */
function createTransactionEntry({ code, mobile_number, amount, payment_link_code, mpesaCheckoutRequestID = null }) {
  const transaction_reference = `PC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // human-friendly unique ref
  const transaction = {
    transaction_reference,          // our internal reference (use to query)
    payment_link_code: code || payment_link_code || null,
    amount,
    mobile_number,
    created_at: new Date().toISOString(),
    status: "initialized",           // initialized -> pending -> success/failed/error
    mpesa: {
      CheckoutRequestID: mpesaCheckoutRequestID,
      MpesaReceiptNumber: null,
      TransactionDate: null,
      TransactionCode: null,         // sometimes provided by webhook
      PaymentName: null,             // e.g., "M-Pesa"
      error_code: null,
      error_message: null
    },
    logs: []
  };
  transactions[transaction_reference] = transaction;
  return transaction;
}

/**
 * Helper: update transaction by reference
 */
function updateTransaction(ref, patch) {
  const tx = transactions[ref];
  if (!tx) return null;
  Object.assign(tx, patch);
  tx.updated_at = new Date().toISOString();
  return tx;
}

/**
 * M-Pesa / PayNecta error mapping
 */
const MPESA_ERROR_MAP = {
  "INSUFFICIENT_FUNDS": "Insufficient funds in customer account.",
  "USER_CANCELLED": "Customer cancelled the transaction on the phone.",
  "SYSTEM_BUSY": "M-Pesa system busy — try again later.",
  "TIMED_OUT": "Transaction timed out (no response from customer).",
  "DUPLICATE_REQUEST": "Duplicate checkout request.",
  "INVALID_PHONE_NUMBER": "The phone number is invalid or not Safaricom.",
  "RESOURCES_NOT_FOUND": "Requested resource not found.",
  "UNKNOWN_ERROR": "Unknown error occurred."
};

function mapMpesaError(codeOrMessage) {
  if (!codeOrMessage) return null;
  if (MPESA_ERROR_MAP[codeOrMessage]) return MPESA_ERROR_MAP[codeOrMessage];
  // fallback pattern matches
  const lower = String(codeOrMessage).toLowerCase();
  if (lower.includes("insufficient")) return MPESA_ERROR_MAP["INSUFFICIENT_FUNDS"];
  if (lower.includes("cancel")) return MPESA_ERROR_MAP["USER_CANCELLED"];
  if (lower.includes("timeout") || lower.includes("timed out")) return MPESA_ERROR_MAP["TIMED_OUT"];
  return MPESA_ERROR_MAP["UNKNOWN_ERROR"];
}

/**
 * Send PayNecta request helper with required headers
 */
async function paynectaRequest(method, path, data = null, params = null) {
  const url = `${PAYNECTA_BASE.replace(/\/$/, "")}/api/v1${path}`;
  const headers = {
    "X-API-Key": PAYNECTA_API_KEY || "",
    "X-User-Email": PAYNECTA_USER_EMAIL || "",
    "Content-Type": "application/json"
  };
  try {
    const resp = await axios({
      method,
      url,
      headers,
      data,
      params,
      timeout: 20000
    });
    return resp.data;
  } catch (err) {
    // Normalize error
    if (err.response && err.response.data) {
      throw { status: err.response.status, data: err.response.data };
    }
    throw { status: 500, data: { success: false, message: err.message } };
  }
}

/**
 * Endpoint: verify authentication
 * Maps to PayNecta: GET /api/v1/auth/verify
 */
app.get("/api/auth/verify", async (req, res) => {
  try {
    const result = await paynectaRequest("get", "/auth/verify");
    return res.json({ success: true, message: "PayNecta auth verified", data: result.data || result });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: "Auth verification failed", error: err.data || err });
  }
});

/**
 * Endpoint: initialize payment (STK Push)
 * POST /api/payment/initialize
 * body: { code: "ABC123", mobile_number: "254700000000", amount: 100 }
 */
app.post("/api/payment/initialize", async (req, res) => {
  const { code, mobile_number, amount } = req.body || {};
  if (!code || !mobile_number || !amount) {
    return res.status(400).json({ success: false, message: "Validation failed", errors: { code: ["Required"], mobile_number: ["Required"], amount: ["Required"] } });
  }

  // Basic client-side validation for Safaricom number
  const msisdn = String(mobile_number);
  if (!/^(2547|07|01)\d{8}$/.test(msisdn)) {
    return res.status(400).json({ success: false, message: "Validation failed", errors: { mobile_number: ["The mobile number must be a valid Safaricom number"] } });
  }

  // Create local transaction record
  const tx = createTransactionEntry({ code, mobile_number: msisdn, amount });

  // Build payload expected by PayNecta
  const payload = {
    code,
    mobile_number: msisdn,
    amount
  };

  try {
    const paynectaResp = await paynectaRequest("post", "/payment/initialize", payload);

    // paynectaResp expected to have data.transaction_reference and data.CheckoutRequestID
    const remoteData = paynectaResp.data || {};
    const remoteTxRef = remoteData.transaction_reference || null;
    const CheckoutRequestID = remoteData.CheckoutRequestID || null;

    // Update the local transaction with remote identifiers
    updateTransaction(tx.transaction_reference, {
      status: "pending",
      "mpesa.CheckoutRequestID": CheckoutRequestID,
      "mpesa.remote_transaction_reference": remoteTxRef,
      logs: [...tx.logs, { at: new Date().toISOString(), note: "Initialized STK Push", paynectaResponse: remoteData }]
    });

    return res.json({
      success: true,
      message: "Payment initiated successfully. Check your phone for the STK push.",
      data: {
        local_transaction_reference: tx.transaction_reference,
        paynecta_transaction_reference: remoteTxRef,
        CheckoutRequestID
      }
    });
  } catch (err) {
    // On failure, mark local tx as error
    const errorMsg = err.data?.message || err.message || "Initialization failed";
    updateTransaction(tx.transaction_reference, {
      status: "error",
      "mpesa.error_message": errorMsg,
      logs: [...tx.logs, { at: new Date().toISOString(), note: "Initialization failed", error: err.data || err.message }]
    });
    return res.status(err.status || 500).json({ success: false, message: "Payment initialization failed", error: err.data || err });
  }
});

/**
 * Endpoint: Query local transaction status by transaction_reference
 * GET /api/payment/status?transaction_reference=PC-...
 */
app.get("/api/payment/status", (req, res) => {
  const { transaction_reference } = req.query;
  if (!transaction_reference) {
    return res.status(400).json({ success: false, message: "transaction_reference query param required" });
  }
  const tx = transactions[transaction_reference];
  if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });
  return res.json({ success: true, data: tx });
});

/**
 * Endpoint: Generate / download PDF receipt for a transaction
 * GET /api/payment/:ref/receipt
 */
app.get("/api/payment/:ref/receipt", (req, res) => {
  const ref = req.params.ref;
  const tx = transactions[ref];
  if (!tx) return res.status(404).json({ success: false, message: "Transaction not found" });

  // Create pdf
  const doc = new PDFDocument({ margin: 40 });
  const filename = `receipt_${ref}.pdf`;
  res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-type", "application/pdf");

  doc.fontSize(20).text("PayCenter - Payment Receipt", { align: "center" });
  doc.moveDown();

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

  doc.moveDown();
  doc.text("Logs (most recent first):", { underline: true });
  const logs = (tx.logs || []).slice().reverse();
  logs.forEach((l) => {
    doc.text(`[${l.at || "N/A"}] ${l.note || JSON.stringify(l)}`);
  });

  doc.end();
  doc.pipe(res);
});

/**
 * Webhook endpoint to receive mpesa callbacks from PayNecta
 * POST /api/webhook/mpesa
 *
 * Expected body: (example)
 * {
 *  "transaction_reference": "ABCP20240803...",
 *  "CheckoutRequestID": "ws_CO_03082024....",
 *  "status": "success",
 *  "mpesa": {
 *     "MpesaReceiptNumber": "ABC1234XYZ",
 *     "TransactionDate": "2024-08-03T12:34:56Z",
 *     "Amount": 100,
 *     "PhoneNumber": "254700000000",
 *     "TransactionCode": "ABC123",
 *     "PaymentName": "M-Pesa"
 *  }
 * }
 *
 * NOTE: PayNecta's webhook payload may vary — adapt field names as needed.
 */
app.post("/api/webhook/mpesa", async (req, res) => {
  const body = req.body || {};
  // Try matching local transaction by CheckoutRequestID or remote transaction_reference if provided
  const { CheckoutRequestID, transaction_reference: remoteRef, status, mpesa } = body;
  let tx = null;

  // Try to find by CheckoutRequestID first
  if (CheckoutRequestID) {
    tx = Object.values(transactions).find(t => t.mpesa.CheckoutRequestID === CheckoutRequestID);
  }
  // Or by remoteRef matching mpesa remote transaction reference
  if (!tx && remoteRef) {
    tx = Object.values(transactions).find(t => t.mpesa.remote_transaction_reference === remoteRef || t.transaction_reference === remoteRef);
  }

  // Fallback: try by phone + amount + pending
  if (!tx && mpesa && mpesa.PhoneNumber && mpesa.Amount) {
    tx = Object.values(transactions).find(t => t.mobile_number === mpesa.PhoneNumber && Number(t.amount) === Number(mpesa.Amount) && t.status === "pending");
  }

  // If still not found, optionally create a new transaction entry (we'll create a record for traceability)
  if (!tx) {
    const guess = createTransactionEntry({ code: null, mobile_number: (mpesa && mpesa.PhoneNumber) || "unknown", amount: (mpesa && mpesa.Amount) || 0, mpesaCheckoutRequestID: CheckoutRequestID });
    tx = transactions[guess.transaction_reference];
    tx.logs.push({ at: new Date().toISOString(), note: "Webhook received but no matching local tx; created placeholder" });
  }

  // Update transaction based on status
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

  // Map status
  let mappedStatus = tx.status;
  if (status) {
    if (status.toLowerCase() === "success" || status.toLowerCase() === "completed" || status.toLowerCase() === "paid") mappedStatus = "success";
    else if (status.toLowerCase() === "failed" || status.toLowerCase() === "error") mappedStatus = "failed";
    else if (status.toLowerCase() === "pending") mappedStatus = "pending";
    else mappedStatus = status.toLowerCase(); // keep verbatim if unknown
  } else if (mpesa && mpesa.Result) {
    // Some providers put result codes
    if (mpesa.Result === "Success") mappedStatus = "success";
  }

  // If there's an error field
  if (mpesa && (mpesa.error_code || mpesa.error_message || mpesa.ResultDesc)) {
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

  // Apply update
  updateTransaction(tx.transaction_reference, newFields);

  // You should respond quickly to webhook originator
  res.json({ success: true, message: "Webhook processed" });
});

/**
 * Utility endpoint: list all transactions (for debugging/demo)
 * GET /api/transactions
 */
app.get("/api/transactions", (req, res) => {
  return res.json({ success: true, data: Object.values(transactions) });
});

/**
 * Fallback
 */
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`PayCenter PayNecta STK backend running on port ${PORT}`);
  console.log(`PAYNECTA_BASE: ${PAYNECTA_BASE}`);
});
