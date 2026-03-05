require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { Resend } = require("resend");

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err));

const buyerSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  paymentId: String,
  orderId: String,
  accessGranted: { type: Boolean, default: false },
  date: { type: Date, default: Date.now },
});

const Buyer = mongoose.model("Buyer", buyerSchema);


const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://contentvault-frontend.vercel.app",
      "https://www.contentvaultpro.online",
      "https://contentvaultpro.online"
    ],
  })
);
app.use(express.json());

// General limiter (all routes)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: "Too many requests, please try again later.",
});

// Strict limiter for payment routes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many payment attempts. Please wait.",
});

app.use(generalLimiter);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Initialize Resend (uses RESEND_API_KEY from environment)
const resend = new Resend(process.env.RESEND_API_KEY);

// Create Order
app.post("/create-order", paymentLimiter, async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_order_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    res.status(500).send("Error creating order");
  }
});

// Verify Payment
app.post("/verify-payment", paymentLimiter, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      email,
    } = req.body;

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false });
    }

    // Save buyer to MongoDB
    const existingBuyer = await Buyer.findOne({ email });

if (!existingBuyer) {
  await Buyer.create({
    email,
    paymentId: razorpay_payment_id,
    orderId: razorpay_order_id,
  });
} else {
  console.log("Duplicate purchase attempt:", email);
}

    console.log("New Buyer saved:", email);

    // Send confirmation email
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: "Payment Received - ContentVault Pro",
      html: `
        <h2>Payment Successful 🎉</h2>
        <p>Thank you for purchasing ContentVault Pro.</p>
        <p>Drive access will be granted shortly.</p>
        <p><strong>Email:</strong> ${email}</p>
      `,
    };

  res.json({ success: true });

    // Send email via Resend (fire-and-forget; we already responded)
    resend.emails.send({
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: mailOptions.html,
    })
    .then(() => console.log("Email sent via Resend"))
    .catch(err => console.log("Resend email failed:", err));



  } catch (error) {
    console.error("Verify Payment Error:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/admin/buyers", async (req, res) => {
  try {
    const adminSecret = req.headers["admin-secret"];

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const buyers = await Buyer.find().sort({ date: -1 });

    res.json(buyers);

  } catch (error) {
    console.error("Admin fetch error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/check-buyer", paymentLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    const existingBuyer = await Buyer.findOne({ email });

    if (existingBuyer) {
      return res.json({ exists: true });
    }

    res.json({ exists: false });

  } catch (error) {
    console.error("Check buyer error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/export", async (req, res) => {
  try {
    const adminSecret = req.headers["admin-secret"];

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const buyers = await Buyer.find().sort({ date: -1 });

    let csv = "Email,Payment ID,Order ID,Date\n";

    buyers.forEach((buyer) => {
      csv += `${buyer.email},${buyer.paymentId},${buyer.orderId},${buyer.date}\n`;
    });

    res.header("Content-Type", "text/csv");
    res.attachment("buyers.csv");
    res.send(csv);

  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/grant-access", async (req, res) => {
  try {
    const adminSecret = req.headers["admin-secret"];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { email } = req.body;

    await Buyer.updateOne(
      { email },
      { accessGranted: true }
    );

    res.json({ success: true });

  } catch (error) {
    console.error("Grant access error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});