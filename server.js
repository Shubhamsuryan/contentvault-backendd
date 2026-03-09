require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");


const { Resend } = require("resend");

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err));

const buyerSchema = new mongoose.Schema({

  name: String,
  email: { type: String, required: true, unique: true },
  phone: String,
  city: String,
  // main purchase
  paymentId: String,
  orderId: String,

  // upsell purchase
  upsellPaymentId: { type: String, default: null },
  upsellOrderId: { type: String, default: null },
  upsellPurchased: { type: Boolean, default: false },

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
    methods: ["GET","POST","PUT","DELETE","HEAD"]
  })
);
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  generalLimiter(req, res, next);
});
// General limiter (all routes)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

// Strict limiter for payment routes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many payment attempts. Please wait.",
});

app.use(generalLimiter);

// Cashfree.XClientId = process.env.CASHFREE_APP_ID;
// Cashfree.XClientSecret = process.env.CASHFREE_SECRET_KEY;
// Cashfree.XEnvironment = CFEnvironment.api;// test mode

// Initialize Resend (uses RESEND_API_KEY from environment)
const resend = new Resend(process.env.RESEND_API_KEY);

// Create Order
const axios = require("axios");

app.get("/health", (req, res) => {
  res.status(200).send("Server is awake");
});

app.get("/", (req, res) => {
  res.send("ContentVault API running");
});

app.post("/create-order", paymentLimiter, async (req, res) => {

  try {

    const { amount, email, name, phone, city, isUpsell } = req.body;
    const orderId = "order_" + Date.now();

    let returnUrl;

    if (isUpsell) {
      // upsell payment finished → go to success
      returnUrl = `https://www.contentvaultpro.online/success?order_id=${orderId}&email=${email}`;
    } else {
      // main payment finished → go to upsell
      returnUrl = `https://www.contentvaultpro.online/upsell?order_id=${orderId}&email=${email}&phone=${phone}&city=${city}`;
    }

    const response = await axios.post(
      "https://api.cashfree.com/pg/orders",
      {
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",

        customer_details: {
          customer_id: name.replace(/\s/g, "_"),
          customer_email: email,
          customer_phone: phone
        },

        order_meta: {
          return_url: returnUrl,
          city: city,
          name: name,
          phone: phone
        }

      },
      {
        headers: {
          "x-client-id": process.env.CASHFREE_APP_ID,
          "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          "x-api-version": "2023-08-01",
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);

  } catch (error) {

    console.error("Cashfree error:", error.response?.data || error.message);
    res.status(500).json({ error: "Order creation failed" });

  }

});

// Verify Payment
app.get("/verify-payment", async (req, res) => {

 const { order_id, email, city} = req.query;

const response = await axios.get(
  `https://api.cashfree.com/pg/orders/${order_id}`,
  {
    headers: {
      "x-client-id": process.env.CASHFREE_APP_ID,
      "x-client-secret": process.env.CASHFREE_SECRET_KEY,
      "x-api-version": "2023-08-01"
    }
  }
);

  console.log("VERIFY PAYMENT API HIT:", order_id, email);

  if (response.data.order_status === "PAID") {

    const order = response.data;

    const existingBuyer = await Buyer.findOne({ email });

    if (!existingBuyer) {

      await Buyer.create({
  name: order.order_meta?.name || order.customer_details.customer_id,
  email: order.customer_details.customer_email,
  phone: order.order_meta?.phone || order.customer_details.customer_phone,
  city: city || "",
  paymentId: order.cf_order_id,
  orderId: order.order_id
});

await resend.emails.send({
  from: "ContentVault <noreply@contentvaultpro.online>",
  to: email,
  subject: "Payment Received - ContentVault Pro",
  html: `
    <h2>Payment Successful 🎉</h2>
    <p>Thank you for purchasing ContentVault Pro.</p>
    <p>You will receive access instructions shortly.</p>
  `
});
    }

    res.json({ success: true });

  } else {

    res.json({ success: false });

  }

});

app.post("/verify-upsell", async (req, res) => {

  try {

    const { order_id, email } = req.body;

    const response = await axios.get(
      `https://api.cashfree.com/pg/orders/${order_id}`,
      {
        headers: {
          "x-client-id": process.env.CASHFREE_APP_ID,
          "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          "x-api-version": "2023-08-01"
        }
      }
    );

    const order = response.data;

    if (order.order_status === "PAID") {

      await Buyer.updateOne(
        { email },
        {
          upsellPaymentId: order.cf_order_id,
          upsellOrderId: order.order_id,
          upsellPurchased: true
        }
      );

      return res.json({ success: true });

    } else {

      return res.json({ success: false });

    }

  } catch (error) {

    console.error("Upsell verify error:", error.response?.data || error.message);
    res.status(500).json({ success: false });

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

    let csv = "Name,Email,Phone,City,Payment ID,Order ID,Upsell,Date\n";

    buyers.forEach((buyer) => {
      csv += `${buyer.name},${buyer.email},${buyer.phone},${buyer.city},${buyer.paymentId},${buyer.orderId},${buyer.upsellPurchased ? "Yes" : "No"},${buyer.date}\n`;
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

app.post("/cashfree-webhook", async (req, res) => {

  try {

    const data = req.body.data;

    if (data.order.order_status === "PAID") {

      const order = data.order;

      const existingBuyer = await Buyer.findOne({
        orderId: order.order_id
      });

      if (!existingBuyer) {

        await Buyer.create({
          name: order.customer_details.customer_id,
          email: order.customer_details.customer_email,
          phone: order.customer_details.customer_phone,
          city: order.order_meta?.city || "",
          paymentId: order.cf_order_id,
          orderId: order.order_id
        });

      }

      console.log("Webhook payment saved");

    }

    res.status(200).send("OK");
    console.log("Webhook received:", req.body);

  } catch (error) {

    console.log("Webhook error", error);
    res.status(500).send("Error");

  }

});


// app.get("/test-email", async (req, res) => {

//   await resend.emails.send({
//     from: "ContentVault <noreply@contentvaultpro.online>",
//     to: "shubhamrajput2565@gmail.com",
//     subject: "Test Email",
//     html: "<p>Resend is working</p>"
//   });

//   res.send("Email sent");

// });

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});