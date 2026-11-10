const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const frontendPath = path.join(__dirname, "backend", "frontend");

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(frontendPath));

let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  } else {
    console.warn("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env.");
  }
} catch (error) {
  console.error("Could not initialize Supabase:", error.message);
}

function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY." });
  }
  next();
}

function sendDatabaseError(res, error, context) {
  console.error(`${context}:`, error);
  return res.status(500).json({ error: "The request could not be completed. Check the server logs and database configuration." });
}

app.get("/api/health", (req, res) => {
  res.status(supabase ? 200 : 503).json({ ok: Boolean(supabase), databaseConfigured: Boolean(supabase) });
});

app.get("/api/products/:barcode", requireDatabase, async (req, res) => {
  const barcode = req.params.barcode.trim();
  if (!barcode || barcode.length > 100) return res.status(400).json({ error: "Enter a valid barcode." });

  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, barcode, name, price")
      .eq("barcode", barcode)
      .maybeSingle();
    if (error) return sendDatabaseError(res, error, "Product lookup failed");
    if (!data) return res.status(404).json({ error: "Product not found. Check the barcode or add the product first." });

    const price = Number(data.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(500).json({ error: "This product has an invalid price in the database." });
    }
    res.json({ ...data, price });
  } catch (error) {
    return sendDatabaseError(res, error, "Product lookup failed");
  }
});

app.post("/api/orders", requireDatabase, async (req, res) => {
  const body = req.body || {};
  const customerName = typeof body.customer_name === "string" ? body.customer_name.trim().slice(0, 120) : "";
  const customerPhone = typeof body.customer_phone === "string" ? body.customer_phone.trim().slice(0, 40) : "";
  const staffName = typeof body.staff_name === "string" ? body.staff_name.trim().slice(0, 120) : "";

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: "Add at least one product before saving the sale." });
  }
  if (body.items.length > 100) return res.status(400).json({ error: "A sale cannot contain more than 100 different products." });

  const requestedItems = [];
  for (const item of body.items) {
    const barcode = typeof item?.barcode === "string" ? item.barcode.trim() : "";
    const qty = Number(item?.qty);
    if (!barcode || barcode.length > 100 || !Number.isInteger(qty) || qty < 1 || qty > 999) {
      return res.status(400).json({ error: "Each item must have a valid barcode and a whole-number quantity from 1 to 999." });
    }
    const existing = requestedItems.find((entry) => entry.barcode === barcode);
    if (existing) existing.qty += qty;
    else requestedItems.push({ barcode, qty });
  }
  if (requestedItems.some((item) => item.qty > 999)) {
    return res.status(400).json({ error: "Combined quantity for a product cannot exceed 999." });
  }

  try {
    // Always use catalog prices and names from the database, never values supplied by the browser.
    const catalogItems = [];
    for (const requested of requestedItems) {
      const { data: product, error } = await supabase
        .from("products")
        .select("id, barcode, name, price")
        .eq("barcode", requested.barcode)
        .maybeSingle();
      if (error) return sendDatabaseError(res, error, "Order product validation failed");
      if (!product) return res.status(400).json({ error: `Product not found for barcode ${requested.barcode}.` });

      const unitPrice = Number(product.price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({ error: `Product ${requested.barcode} has an invalid catalog price.` });
      }
      catalogItems.push({ product, qty: requested.qty, unitPrice });
    }

    let customerId = null;
    if (customerName || customerPhone) {
      const { data: customer, error } = await supabase
        .from("customers")
        .insert([{ name: customerName || null, phone: customerPhone || null }])
        .select("id")
        .single();
      if (error) return sendDatabaseError(res, error, "Customer save failed");
      customerId = customer.id;
    }

    const totalAmount = Number(catalogItems.reduce((sum, item) => sum + item.unitPrice * item.qty, 0).toFixed(2));
    const orderCode = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([{
        order_code: orderCode,
        customer_id: customerId,
        staff_name: staffName || null,
        status: "pending",
        total_amount: totalAmount
      }])
      .select("id, order_code, status, total_amount, created_at")
      .single();
    if (orderError) return sendDatabaseError(res, orderError, "Order save failed");

    const orderItems = catalogItems.map(({ product, qty, unitPrice }) => ({
      order_id: order.id,
      product_id: product.id || null,
      barcode: product.barcode,
      product_name: product.name,
      unit_price: unitPrice,
      qty,
      line_total: Number((unitPrice * qty).toFixed(2))
    }));
    const { error: itemsError } = await supabase.from("order_items").insert(orderItems);
    if (itemsError) return sendDatabaseError(res, itemsError, "Order items save failed");

    return res.status(201).json({ success: true, order_id: order.id, order_code: orderCode, total_amount: totalAmount });
  } catch (error) {
    return sendDatabaseError(res, error, "Order save failed");
  }
});

app.get("/api/orders/:orderCode", requireDatabase, async (req, res) => {
  const orderCode = req.params.orderCode.trim();
  try {
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, order_code, status, total_amount, created_at, staff_name")
      .eq("order_code", orderCode)
      .maybeSingle();
    if (orderError) return sendDatabaseError(res, orderError, "Order lookup failed");
    if (!order) return res.status(404).json({ error: "Invoice not found." });

    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select("product_name, barcode, qty, unit_price, line_total")
      .eq("order_id", order.id);
    if (itemsError) return sendDatabaseError(res, itemsError, "Invoice items lookup failed");
    return res.json({ order, items: items || [] });
  } catch (error) {
    return sendDatabaseError(res, error, "Order lookup failed");
  }
});

app.get("/print/:orderCode", (req, res) => {
  res.sendFile(path.join(frontendPath, "print.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? "Request is too large." : "Invalid request." });
});

app.listen(PORT, () => console.log(`POS server listening on port ${PORT}`));
