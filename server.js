const express = require('express');
const path = require('path');
const os = require('os');
const { 
    initDatabase, 
    getDbConnection, 
    allocateFEFOBatches, 
    verifySupervisorOverride,
    getNearExpiryAlerts,
    getLowStockAlerts,
    getDeadStock,
    getDailyMarginsReport
} = require('./db');

const app = express();
let activePort = 8080;

app.use(express.json());

// Initialize database & tables
initDatabase();

// 1. UTILITY: Get Local LAN IP Address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            // Check for IPv4 and non-internal loopbacks (e.g. not 127.0.0.1)
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// 2. ENDPOINT: Network Information
app.get('/api/network-ip', (req, res) => {
    res.json({
        ip: getLocalIpAddress(),
        port: activePort,
        url: `http://${getLocalIpAddress()}:${activePort}`
    });
});

// 3. ENDPOINT: User Authentication
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const conn = getDbConnection();
    
    try {
        const user = conn.prepare("SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = ?").get(username);
        
        if (!user || user.is_active === 0) {
            return res.status(401).json({ error: "Invalid credentials or inactive account" });
        }
        
        const bcrypt = require('bcryptjs');
        const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
        
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        
        res.json({
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            role: user.role
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Verify Supervisor Override credentials
app.post('/api/auth/override', (req, res) => {
    const { username, password } = req.body;
    const result = verifySupervisorOverride(username, password);
    if (result.success) {
        res.json({ success: true, message: result.message });
    } else {
        res.status(401).json({ success: false, error: result.message });
    }
});

// 4. ENDPOINT: Products CRUD & Search
app.get('/api/products', (req, res) => {
    const { search } = req.query;
    const conn = getDbConnection();
    
    try {
        let products;
        const baseSql = `
            SELECT p.id, p.product_name, p.generic_name, p.sku, p.barcode, p.category, p.form, p.pack_size, 
                   p.base_unit_multiplier, p.reorder_level, p.is_prescription_required, p.minimum_order_quantity,
                   IFNULL((SELECT cost_price FROM product_batches pb WHERE pb.product_id = p.id ORDER BY pb.quantity_on_hand DESC, pb.expiry_date ASC LIMIT 1), 0.0) as cost_price,
                   IFNULL((SELECT selling_price FROM product_batches pb WHERE pb.product_id = p.id ORDER BY pb.quantity_on_hand DESC, pb.expiry_date ASC LIMIT 1), 0.0) as selling_price,
                   IFNULL((SELECT SUM(pb.quantity_on_hand) FROM product_batches pb WHERE pb.product_id = p.id), 0) as total_qty
            FROM products p
        `;
        if (search) {
            const queryParam = `%${search}%`;
            products = conn.prepare(`
                ${baseSql}
                WHERE p.product_name LIKE ? 
                   OR p.generic_name LIKE ? 
                   OR p.sku LIKE ? 
                   OR p.barcode = ?
            `).all(queryParam, queryParam, queryParam, search);
        } else {
            products = conn.prepare(baseSql).all();
        }
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', (req, res) => {
    const { 
        product_name, generic_name, sku, barcode, category, form, 
        pack_size, base_unit_multiplier, reorder_level, is_prescription_required,
        minimum_order_quantity, quantity, cost_price, selling_price
    } = req.body;
    
    const conn = getDbConnection();
    
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        // Insert product
        const stmt = conn.prepare(`
            INSERT INTO products (product_name, generic_name, sku, barcode, category, form, pack_size, base_unit_multiplier, reorder_level, is_prescription_required, minimum_order_quantity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            product_name, 
            generic_name || null, 
            sku || null, 
            barcode || null, 
            category, 
            form, 
            pack_size || 'Unit', 
            base_unit_multiplier || 1, 
            reorder_level || 10, 
            is_prescription_required || 0,
            minimum_order_quantity || 1
        );
        const productId = result.lastInsertRowid;
        
        // Always seed batch-init to store default pricing (even if qty is 0)
        const initialQty = parseInt(quantity) || 0;
        const costVal = parseFloat(cost_price) || 0.0;
        const sellVal = parseFloat(selling_price) || 0.0;
        
        const insertBatch = conn.prepare(`
            INSERT INTO product_batches (product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name)
            VALUES (?, 'BATCH-INIT', DATE('now', '+365 days'), ?, ?, ?, 'Initial Stock Setup')
        `);
        const batchRes = insertBatch.run(productId, initialQty, costVal, sellVal);
        const batchId = batchRes.lastInsertRowid;
        
        if (initialQty > 0) {
            const insertLedger = conn.prepare(`
                INSERT INTO stock_ledger (product_id, batch_id, transaction_type, quantity_changed, reference_id, user_id)
                VALUES (?, ?, 'INITIAL_STOCK', ?, 'INIT_REGISTRATION', 1)
            `);
            insertLedger.run(productId, batchId, initialQty);
        }
        
        conn.exec("COMMIT;");
        res.json({ success: true, productId: productId });
    } catch (err) {
        conn.exec("ROLLBACK;");
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/:id', (req, res) => {
    const id = req.params.id;
    const { 
        product_name, generic_name, category, form, 
        is_prescription_required, minimum_order_quantity,
        cost_price, selling_price
    } = req.body;
    
    const conn = getDbConnection();
    
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        const stmt = conn.prepare(`
            UPDATE products 
            SET product_name = ?, 
                generic_name = ?, 
                category = ?, 
                form = ?, 
                is_prescription_required = ?, 
                minimum_order_quantity = ?, 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(
            product_name, 
            generic_name || null, 
            category, 
            form, 
            is_prescription_required || 0, 
            minimum_order_quantity || 1, 
            id
        );
        
        const costVal = parseFloat(cost_price) || 0.0;
        const sellVal = parseFloat(selling_price) || 0.0;
        
        // Update price in initial batch
        const checkBatch = conn.prepare("SELECT id FROM product_batches WHERE product_id = ? AND batch_number = 'BATCH-INIT'").get(id);
        if (checkBatch) {
            const updateBatch = conn.prepare(`
                UPDATE product_batches 
                SET cost_price = ?, selling_price = ?
                WHERE id = ?
            `);
            updateBatch.run(costVal, sellVal, checkBatch.id);
        } else {
            const insertBatch = conn.prepare(`
                INSERT INTO product_batches (product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name)
                VALUES (?, 'BATCH-INIT', DATE('now', '+365 days'), 0, ?, ?, 'Initial Stock Setup')
            `);
            insertBatch.run(id, costVal, sellVal);
        }
        
        conn.exec("COMMIT;");
        res.json({ success: true });
    } catch (err) {
        conn.exec("ROLLBACK;");
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/products/:id (Delete product registry entry)
app.delete('/api/products/:id', (req, res) => {
    const id = req.params.id;
    const conn = getDbConnection();
    
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        // Check if there are active sales using this product
        const salesCount = conn.prepare("SELECT COUNT(*) as count FROM invoice_items WHERE product_id = ?").get(id);
        if (salesCount.count > 0) {
            return res.status(400).json({ error: "Cannot delete product. It has associated sales transactions." });
        }
        
        // Delete associated product batches
        conn.prepare("DELETE FROM product_batches WHERE product_id = ?").run(id);
        
        // Delete product
        conn.prepare("DELETE FROM products WHERE id = ?").run(id);
        
        conn.exec("COMMIT;");
        res.json({ success: true });
    } catch (err) {
        try { conn.exec("ROLLBACK;"); } catch(_) {}
        res.status(500).json({ error: err.message });
    }
});

// 5. ENDPOINT: Batches Retrieval & Storage
app.get('/api/products/:productId/batches', (req, res) => {
    const productId = req.params.productId;
    const conn = getDbConnection();
    
    try {
        const batches = conn.prepare(`
            SELECT id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name, received_date
            FROM product_batches
            WHERE product_id = ?
            ORDER BY expiry_date ASC
        `).all(productId);
        res.json(batches);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/batches', (req, res) => {
    const { 
        product_id, batch_number, expiry_date, quantity_on_hand, 
        cost_price, selling_price, supplier_name, user_id 
    } = req.body;
    
    const conn = getDbConnection();
    
    try {
        // Run as transaction
        conn.exec("BEGIN TRANSACTION;");
        
        // 1. Insert or update batch
        const insertBatch = conn.prepare(`
            INSERT INTO product_batches (product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id, batch_number) DO UPDATE SET
                quantity_on_hand = quantity_on_hand + EXCLUDED.quantity_on_hand,
                expiry_date = EXCLUDED.expiry_date,
                cost_price = EXCLUDED.cost_price,
                selling_price = EXCLUDED.selling_price,
                supplier_name = EXCLUDED.supplier_name
        `);
        
        const resBatch = insertBatch.run(
            product_id, batch_number, expiry_date, quantity_on_hand, 
            cost_price, selling_price, supplier_name
        );
        
        // Query the batch ID (needed for ledger entry)
        const batchRow = conn.prepare("SELECT id FROM product_batches WHERE product_id = ? AND batch_number = ?").get(product_id, batch_number);
        const batchId = batchRow.id;
        
        // 2. Write entry to audit stock_ledger
        const insertLedger = conn.prepare(`
            INSERT INTO stock_ledger (product_id, batch_id, transaction_type, quantity_changed, reference_id, user_id)
            VALUES (?, ?, 'SUPPLIER_RESTOCK', ?, 'SUPPLIER_INCOMING', ?)
        `);
        insertLedger.run(product_id, batchId, quantity_on_hand, user_id || 1);
        
        conn.exec("COMMIT;");
        res.json({ success: true, batchId: batchId });
    } catch (err) {
        conn.exec("ROLLBACK;");
        res.status(500).json({ error: err.message });
    }
});

// 6. ENDPOINT: POS Cart Checkout Processing
app.post('/api/checkout', (req, res) => {
    const { 
        user_id, customer_name, customer_phone, payment_method, 
        items, doctor_name, doctor_license_number 
    } = req.body;
    
    const conn = getDbConnection();
    
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        // Compute serial invoice number (INV-YYYYMMDD-XXXX)
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
        const todayCountRow = conn.prepare("SELECT COUNT(*) as count FROM invoices WHERE DATE(created_at) = DATE('now')").get();
        const seq = String(todayCountRow.count + 1).padStart(4, '0');
        const invoiceNumber = `INV-${dateStr}-${seq}`;
        
        // 1. Create invoice parent row
        const insertInvoice = conn.prepare(`
            INSERT INTO invoices (invoice_number, user_id, customer_name, customer_phone, total_amount, payment_method, doctor_name, doctor_license_number)
            VALUES (?, ?, ?, ?, 0.0, ?, ?, ?)
        `);
        const invResult = insertInvoice.run(
            invoiceNumber, user_id, customer_name || 'Walk-in Customer', 
            customer_phone || null, payment_method, doctor_name || null, doctor_license_number || null
        );
        const invoiceId = invResult.lastInsertRowid;
        
        let totalAmount = 0.0;
        
        // 2. Loop through cart items and apply FEFO batch calculations
        for (const item of items) {
            const { product_id, quantity, sell_type } = item;
            
            // Check if product exists and if prescription is required
            const product = conn.prepare("SELECT product_name, category, is_prescription_required, base_unit_multiplier FROM products WHERE id = ?").get(product_id);
            if (!product) {
                throw new Error(`Product with ID ${product_id} not found.`);
            }
            
            // Check prescription compliance
            if (product.is_prescription_required === 1) {
                if (!doctor_name || !doctor_license_number) {
                    throw new Error(`Prescription required for ${product.product_name}. Doctor details must be supplied.`);
                }
            }
            
            // Convert packaging units to base units
            let rawQuantityToDeduct = Number(quantity);
            if (sell_type === 'PACK') {
                rawQuantityToDeduct = Number(quantity) * product.base_unit_multiplier;
            }
            
            // Allocate using FEFO algorithm
            const allocations = allocateFEFOBatches(product_id, rawQuantityToDeduct);
            
            for (const alloc of allocations) {
                const subtotal = alloc.quantity_allocated * alloc.selling_price;
                totalAmount += subtotal;
                
                // Write transaction items
                const insertItem = conn.prepare(`
                    INSERT INTO invoice_items (invoice_id, product_id, batch_id, quantity_sold, unit_price, subtotal)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                // Note: The trg_deduct_stock_on_sale SQLite trigger will run automatically on INSERT
                insertItem.run(invoiceId, product_id, alloc.batch_id, alloc.quantity_allocated, alloc.selling_price, subtotal);
                
                // Write audit ledger record
                const insertLedger = conn.prepare(`
                    INSERT INTO stock_ledger (product_id, batch_id, transaction_type, quantity_changed, reference_id, user_id)
                    VALUES (?, ?, 'SALE', ?, ?, ?)
                `);
                insertLedger.run(product_id, alloc.batch_id, -alloc.quantity_allocated, invoiceNumber, user_id);
            }
        }
        
        // 3. Update parent invoice total sum
        const updateInvoiceTotal = conn.prepare(`
            UPDATE invoices 
            SET total_amount = ? 
            WHERE id = ?
        `);
        updateInvoiceTotal.run(totalAmount, invoiceId);
        
        // Log invoice to sync_queue for cloud upload
        const invoiceRow = conn.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
        const invoiceItems = conn.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(invoiceId);
        const syncPayload = {
            ...invoiceRow,
            items: invoiceItems
        };
        
        const insertSyncQueue = conn.prepare(`
            INSERT INTO sync_queue (table_name, record_id, action_type, payload)
            VALUES ('invoices', ?, 'INSERT', ?)
        `);
        insertSyncQueue.run(invoiceNumber, JSON.stringify(syncPayload));
        
        conn.exec("COMMIT;");
        
        res.json({
            success: true,
            invoice_id: invoiceId,
            invoice_number: invoiceNumber,
            total_amount: totalAmount
        });
        
    } catch (err) {
        conn.exec("ROLLBACK;");
        res.status(400).json({ error: err.message });
    }
});

// 7. ENDPOINTS: Analytics Reports & Views
app.get('/api/reports/near-expiry', (req, res) => {
    try {
        const alerts = getNearExpiryAlerts();
        res.json(alerts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/low-stock', (req, res) => {
    try {
        const queue = getLowStockAlerts();
        res.json(queue);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/dead-stock', (req, res) => {
    try {
        const dead = getDeadStock();
        res.json(dead);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/daily-margins', (req, res) => {
    try {
        const report = getDailyMarginsReport();
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/reports/sales-ledger (Today's sale list with date filters)
app.get('/api/reports/sales-ledger', (req, res) => {
    const { filter } = req.query;
    const conn = getDbConnection();
    
    try {
        let dateCondition = "1=1"; // default: all time
        
        if (filter === 'today') {
            dateCondition = "DATE(i.created_at) = DATE('now')";
        } else if (filter === 'yesterday') {
            dateCondition = "DATE(i.created_at) = DATE('now', '-1 day')";
        } else if (filter === 'last7days') {
            dateCondition = "DATE(i.created_at) >= DATE('now', '-7 days')";
        } else if (filter === 'thismonth') {
            dateCondition = "STRFTIME('%Y-%m', i.created_at) = STRFTIME('%Y-%m', 'now')";
        } else if (filter === 'lastmonth') {
            dateCondition = "STRFTIME('%Y-%m', i.created_at) = STRFTIME('%Y-%m', 'now', '-1 month')";
        } else if (filter === 'thisyear') {
            dateCondition = "STRFTIME('%Y', i.created_at) = STRFTIME('%Y', 'now')";
        } else if (filter === 'last365days') {
            dateCondition = "DATE(i.created_at) >= DATE('now', '-365 days')";
        }

        const sql = `
            SELECT i.id, i.invoice_number, i.created_at, i.customer_name, i.payment_method, i.total_amount,
                   u.full_name as cashier_name,
                   (SELECT GROUP_CONCAT(p.product_name || ' (x' || ii.quantity_sold || ')', ', ') 
                    FROM invoice_items ii 
                    JOIN products p ON ii.product_id = p.id 
                    WHERE ii.invoice_id = i.id) as items_summary
            FROM invoices i
            JOIN users u ON i.user_id = u.id
            WHERE ${dateCondition}
            ORDER BY i.created_at DESC
        `;
        const ledger = conn.prepare(sql).all();
        res.json(ledger);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/users (List all system staff accounts)
app.get('/api/users', (req, res) => {
    const conn = getDbConnection();
    try {
        const users = conn.prepare("SELECT id, username, full_name, role, is_active FROM users").all();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/users (Create a new system user account)
app.post('/api/users', (req, res) => {
    const { username, password, full_name, role } = req.body;
    const conn = getDbConnection();
    const bcrypt = require('bcryptjs');
    
    try {
        // Check if username already exists
        const exists = conn.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (exists) {
            return res.status(400).json({ error: "Username already exists." });
        }
        
        const passwordHash = bcrypt.hashSync(password, 10);
        const stmt = conn.prepare(`
            INSERT INTO users (username, password_hash, full_name, role)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(username, passwordHash, full_name, role);
        res.json({ success: true, userId: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/users/:id (Toggle status active/inactive)
app.put('/api/users/:id', (req, res) => {
    const id = req.params.id;
    const { is_active } = req.body;
    const conn = getDbConnection();
    
    try {
        const stmt = conn.prepare("UPDATE users SET is_active = ? WHERE id = ?");
        stmt.run(is_active, id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/users/:id/reset-password (Reset system user's password)
app.put('/api/users/:id/reset-password', (req, res) => {
    const id = req.params.id;
    const { password } = req.body;
    const conn = getDbConnection();
    const bcrypt = require('bcryptjs');
    
    if (!password || password.trim().length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }
    
    try {
        const passwordHash = bcrypt.hashSync(password, 10);
        const stmt = conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
        stmt.run(passwordHash, id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/users/:id/profile (Update display name and/or password for the profile modal)
app.put('/api/users/:id/profile', (req, res) => {
    const id = req.params.id;
    const { full_name, password } = req.body;
    const conn = getDbConnection();
    const bcrypt = require('bcryptjs');
    
    if (!full_name || full_name.trim().length === 0) {
        return res.status(400).json({ error: "Display name cannot be empty." });
    }
    
    try {
        if (password && password.trim().length > 0) {
            if (password.trim().length < 6) {
                return res.status(400).json({ error: "Password must be at least 6 characters long." });
            }
            const passwordHash = bcrypt.hashSync(password, 10);
            const stmt = conn.prepare("UPDATE users SET full_name = ?, password_hash = ? WHERE id = ?");
            stmt.run(full_name, passwordHash, id);
        } else {
            const stmt = conn.prepare("UPDATE users SET full_name = ? WHERE id = ?");
            stmt.run(full_name, id);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/activation-status (Check if store has configured cloud details)
app.get('/api/activation-status', (req, res) => {
    const conn = getDbConnection();
    try {
        const storeSlug = conn.prepare("SELECT config_value FROM system_config WHERE config_key = 'store_slug'").get();
        const apiKey = conn.prepare("SELECT config_value FROM system_config WHERE config_key = 'sync_api_key'").get();
        
        const isActivated = storeSlug && storeSlug.config_value && apiKey && apiKey.config_value;
        res.json({ activated: !!isActivated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/activate (Trigger cloud verification, save credentials, and seed admin account)
app.post('/api/activate', async (req, res) => {
    const { cloud_url, store_slug, sync_api_key, admin_fullname, admin_username, admin_password } = req.body;
    const conn = getDbConnection();
    
    if (!cloud_url || !store_slug || !sync_api_key || !admin_fullname || !admin_username || !admin_password) {
        return res.status(400).json({ error: "Missing required activation or administrator credentials." });
    }
    
    if (admin_password.trim().length < 6) {
        return res.status(400).json({ error: "Administrator password must be at least 6 characters long." });
    }
    
    try {
        // 1. Send validation request to Render cloud database sync gateway
        console.log(`[Activation] Verifying store '${store_slug}' against cloud: ${cloud_url}`);
        const testRes = await fetch(`${cloud_url}/api/sync/pull?since=1970-01-01%2000:00:00`, {
            method: 'GET',
            headers: {
                'X-Store-API-Key': sync_api_key.trim(),
                'X-Store-Slug': store_slug.trim()
            }
        });
        
        if (!testRes.ok) {
            const errData = await testRes.json().catch(() => ({}));
            return res.status(400).json({ error: errData.error || `Cloud server returned status code ${testRes.status}` });
        }
        
        // 2. Write verified sync details to local system_config table
        conn.exec("BEGIN TRANSACTION;");
        conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('cloud_url', ?)").run(cloud_url.trim());
        conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('store_slug', ?)").run(store_slug.trim());
        conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('sync_api_key', ?)").run(sync_api_key.trim());
        
        // 3. Auto-provision the custom local admin account if no accounts exist
        const checkUsers = conn.prepare("SELECT COUNT(*) as count FROM users").get();
        if (checkUsers.count === 0) {
            console.log(`[Activation] Seeding initial custom Admin account: ${admin_username}`);
            const insertUser = conn.prepare(`
                INSERT INTO users (username, password_hash, full_name, role)
                VALUES (?, ?, ?, 'ADMIN')
            `);
            const bcrypt = require('bcryptjs');
            insertUser.run(admin_username.trim().toLowerCase(), bcrypt.hashSync(admin_password, 10), admin_fullname.trim());
        }
        
        conn.exec("COMMIT;");
        console.log("[Activation] Store activated successfully. Custom admin created.");
        res.json({ success: true });
    } catch (err) {
        try { conn.exec("ROLLBACK;"); } catch(_) {}
        console.error("[Activation] Failed:", err.message);
        res.status(500).json({ error: `Connection failed: ${err.message}. Is the cloud server URL correct and online?` });
    }
});

// GET /api/config (Retrieve local sync credentials)
app.get('/api/config', (req, res) => {
    const conn = getDbConnection();
    try {
        const rows = conn.prepare("SELECT config_key, config_value FROM system_config").all();
        const config = {};
        rows.forEach(r => { config[r.config_key] = r.config_value; });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/config (Update local sync credentials)
app.post('/api/config', (req, res) => {
    const { store_slug, sync_api_key, cloud_url } = req.body;
    const conn = getDbConnection();
    try {
        conn.exec("BEGIN TRANSACTION;");
        if (store_slug !== undefined) conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('store_slug', ?)").run(store_slug.trim());
        if (sync_api_key !== undefined) conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('sync_api_key', ?)").run(sync_api_key.trim());
        if (cloud_url !== undefined) conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('cloud_url', ?)").run(cloud_url.trim());
        conn.exec("COMMIT;");
        res.json({ success: true });
    } catch (err) {
        try { conn.exec("ROLLBACK;"); } catch(_) {}
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sync/queue (Retrieve pending queue events for push)
app.get('/api/sync/queue', (req, res) => {
    const conn = getDbConnection();
    try {
        const rows = conn.prepare("SELECT id, table_name, record_id, action_type, payload FROM sync_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 50").all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync/queue/ack (Acknowledge and mark events as synced)
app.post('/api/sync/queue/ack', (req, res) => {
    const { ids } = req.body;
    const conn = getDbConnection();
    if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({ error: "Invalid ack payload." });
    }
    try {
        conn.exec("BEGIN TRANSACTION;");
        const stmt = conn.prepare("UPDATE sync_queue SET status = 'synced' WHERE id = ?");
        for (const id of ids) {
            stmt.run(id);
        }
        conn.exec("COMMIT;");
        res.json({ success: true });
    } catch (err) {
        try { conn.exec("ROLLBACK;"); } catch(_) {}
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync/queue/fail (Mark event as failed with error msg)
app.post('/api/sync/queue/fail', (req, res) => {
    const { id, error } = req.body;
    const conn = getDbConnection();
    try {
        const stmt = conn.prepare("UPDATE sync_queue SET status = 'failed', error_message = ? WHERE id = ?");
        stmt.run(error || 'Sync failed', id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync/apply (Apply cloud pulled data changes locally)
app.post('/api/sync/apply', (req, res) => {
    const { products, product_batches, users, last_sync_timestamp } = req.body;
    const conn = getDbConnection();
    
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        // 1. Apply Products Updates/Inserts
        if (products && Array.isArray(products)) {
            const stmt = conn.prepare(`
                INSERT OR REPLACE INTO products (id, product_name, generic_name, sku, barcode, category, form, pack_size, base_unit_multiplier, reorder_level, is_prescription_required, minimum_order_quantity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const p of products) {
                stmt.run(
                    p.id, p.product_name, p.generic_name || null, p.sku || null, p.barcode || null,
                    p.category, p.form, p.pack_size || null, p.base_unit_multiplier || 1,
                    p.reorder_level || 10, p.is_prescription_required || 0, p.minimum_order_quantity || 1
                );
            }
        }
        
        // 2. Apply Batches Updates/Inserts
        if (product_batches && Array.isArray(product_batches)) {
            const stmt = conn.prepare(`
                INSERT OR REPLACE INTO product_batches (id, product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name, received_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const b of product_batches) {
                stmt.run(
                    b.id, b.product_id, b.batch_number, b.expiry_date, b.quantity_on_hand,
                    b.cost_price, b.selling_price, b.supplier_name || null, b.received_date || null
                );
            }
        }
        
        // 3. Apply Users Updates/Inserts (Exclude admin settings locally if required, but sync all staff accounts)
        if (users && Array.isArray(users)) {
            const stmt = conn.prepare(`
                INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, is_active)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const u of users) {
                stmt.run(u.id, u.username, u.password_hash, u.full_name, u.role, u.is_active || 1);
            }
        }
        
        // 4. Update the sync timestamp
        if (last_sync_timestamp) {
            conn.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('last_sync_timestamp', ?)")
                .run(last_sync_timestamp);
        }
        
        conn.exec("COMMIT;");
        res.json({ success: true });
    } catch (err) {
        try { conn.exec("ROLLBACK;"); } catch(_) {}
        res.status(500).json({ error: err.message });
    }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'renderer')));

// Catch-all route to serve the SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'renderer', 'index.html'));
});

// Start listening
function startServer(port) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '0.0.0.0', () => {
            activePort = port;
            console.log(`[Express] Local server active at http://localhost:${port}`);
            console.log(`[Express] LAN access active at http://${getLocalIpAddress()}:${port}`);
            resolve({ server, port });
        });
        
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[Express] Port ${port} is in use, trying ${port + 1}...`);
                resolve(startServer(port + 1));
            } else {
                reject(err);
            }
        });
    });
}

module.exports = { app, startServer };
