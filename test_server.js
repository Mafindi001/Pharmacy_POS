const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Isolate tests from the live database — must be set BEFORE requiring ./db
process.env.PHARMACY_DB_PATH = path.join(os.tmpdir(), `rxpos_test_${process.pid}.db`);

const {
    initDatabase,
    getDbConnection,
    allocateFEFOBatches,
    verifySupervisorOverride,
    getNearExpiryAlerts,
    getLowStockAlerts,
    getDeadStock,
    getDailyMarginsReport,
    dbPath
} = require('./db');

async function runTests() {
    console.log("==========================================");
    console.log("STARTING AUTOMATED POS BACKEND LOGIC TESTS");
    console.log("==========================================");

    // 1. Reset database for testing
    console.log("[Test] Resetting SQLite test database file...");
    if (fs.existsSync(dbPath)) {
        try {
            // Close connection to allow file deletion
            const conn = getDbConnection();
            conn.exec("PRAGMA optimize;"); // Clean up
        } catch (e) {}
        
        // Wait briefly and delete
        try {
            fs.unlinkSync(dbPath);
            console.log("[Test] Database file unlinked.");
        } catch (e) {
            console.warn("[Test] Database file busy. Wiping tables instead.");
            const conn = getDbConnection();
            conn.exec("PRAGMA foreign_keys = OFF;");
            conn.exec("DROP TABLE IF EXISTS stock_ledger;");
            conn.exec("DROP TABLE IF EXISTS invoice_items;");
            conn.exec("DROP TABLE IF EXISTS invoices;");
            conn.exec("DROP TABLE IF EXISTS product_batches;");
            conn.exec("DROP TABLE IF EXISTS products;");
            conn.exec("DROP TABLE IF EXISTS users;");
            conn.exec("PRAGMA foreign_keys = ON;");
        }
    }

    // 2. Initialize Database & Seed Users
    initDatabase();
    const conn = getDbConnection();

    // Seed staff accounts (ids 1-3) referenced by ledger/invoice foreign keys
    const bcryptSeed = require('bcryptjs');
    const seedUser = conn.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)");
    seedUser.run('admin', bcryptSeed.hashSync('adminpass', 10), 'Seed Admin', 'ADMIN');           // id 1
    seedUser.run('pharma', bcryptSeed.hashSync('pharmapass', 10), 'Seed Pharmacist', 'PHARMACIST'); // id 2
    seedUser.run('cashier', bcryptSeed.hashSync('cashierpass', 10), 'Seed Cashier', 'CASHIER');    // id 3
    console.log("[Test] Schema initialized and staff seeded.");

    // 3. Register Test Products
    console.log("[Test] Seeding products...");
    const insertProduct = conn.prepare(`
        INSERT INTO products (product_name, generic_name, sku, barcode, category, form, pack_size, base_unit_multiplier, reorder_level, is_prescription_required)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Product 1: Paracetamol (regular)
    insertProduct.run(
        "Paracetamol 500mg", "Acetaminophen", "SKU-PARA-100", "500123456", 
        "Analgesics", "Tablet", "Box of 100", 10, 30, 0
    );
    const paraId = 1;

    // Product 2: Morphine (regulated narcotic)
    insertProduct.run(
        "Morphine Sulfate 10mg", "Morphine", "SKU-MORPH-001", "600987654", 
        "Narcotics", "Tablet", "Box of 20", 1, 5, 1
    );
    const morphId = 2;

    // 4. Add Batches (Expiring, Expired, In-Stock)
    console.log("[Test] Seeding stock batches...");
    const insertBatch = conn.prepare(`
        INSERT INTO product_batches (product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Paracetamol Batch A: Expiring very soon (30 days from now), 50 units
    const dateSoon = new Date();
    dateSoon.setDate(dateSoon.getDate() + 30);
    const expirySoon = dateSoon.toISOString().slice(0, 10);
    insertBatch.run(paraId, "B-PARA-SOON", expirySoon, 50, 1.5, 3.0, "Global Pharma");

    // Paracetamol Batch B: Expiring later (300 days from now), 100 units
    const dateLate = new Date();
    dateLate.setDate(dateLate.getDate() + 300);
    const expiryLate = dateLate.toISOString().slice(0, 10);
    insertBatch.run(paraId, "B-PARA-LATE", expiryLate, 100, 1.4, 2.8, "Global Pharma");

    // Paracetamol Batch C: Already Expired (20 days ago), 80 units
    const dateExpired = new Date();
    dateExpired.setDate(dateExpired.getDate() - 20);
    const expiryExpired = dateExpired.toISOString().slice(0, 10);
    insertBatch.run(paraId, "B-PARA-EXPIRED", expiryExpired, 80, 1.0, 2.0, "Global Pharma");

    // Morphine Batch: 20 units
    insertBatch.run(morphId, "B-MORPH-01", expiryLate, 20, 10.0, 20.0, "Sandoz");

    // Log restocks in ledger
    const insertLedger = conn.prepare(`
        INSERT INTO stock_ledger (product_id, batch_id, transaction_type, quantity_changed, reference_id, user_id)
        VALUES (?, ?, 'SUPPLIER_RESTOCK', ?, 'TEST_RECEIPT', ?)
    `);
    insertLedger.run(paraId, 1, 50, 1);
    insertLedger.run(paraId, 2, 100, 1);
    insertLedger.run(paraId, 3, 80, 1);
    insertLedger.run(morphId, 4, 20, 1);

    // ==========================================
    // TEST AREA 1: FEFO ALGORITHMIC DISPENSING
    // ==========================================
    console.log("\n[TEST 1] Testing FEFO batch allocation...");
    
    // We request 70 units of Paracetamol.
    // Algorithm must allocate:
    // - 50 units from B-PARA-SOON (closest active expiry)
    // - 20 units from B-PARA-LATE (next active expiry)
    // - ZERO units from B-PARA-EXPIRED (because it's expired)
    try {
        const allocations = allocateFEFOBatches(paraId, 70);
        console.log("[Test 1 Output] FEFO Allocations:", JSON.stringify(allocations, null, 2));
        
        if (allocations.length !== 2) throw new Error("Should allocate from exactly 2 active batches.");
        if (allocations[0].batch_number !== "B-PARA-SOON" || allocations[0].quantity_allocated !== 50) {
            throw new Error("First allocation should be 50 units from B-PARA-SOON.");
        }
        if (allocations[1].batch_number !== "B-PARA-LATE" || allocations[1].quantity_allocated !== 20) {
            throw new Error("Second allocation should be 20 units from B-PARA-LATE.");
        }
        console.log("✓ TEST 1 SUCCESS: FEFO allocates closest non-expired batches correctly!");
    } catch (e) {
        console.error("✗ TEST 1 FAILED:", e.message);
        process.exit(1);
    }

    // ==========================================
    // TEST AREA 2: EXPIRED BATCH EXCLUSION
    // ==========================================
    console.log("\n[TEST 2] Testing complete stock depletion & expired locks...");
    try {
        // Total active stock is 50 + 100 = 150 units. Wiping expired batch leaves it out.
        // If we request 160 units, it must fail because the 80 expired units cannot be touched.
        try {
            allocateFEFOBatches(paraId, 160);
            throw new Error("Should have thrown an error due to insufficient ACTIVE stock.");
        } catch (err) {
            console.log(`[Test 2 Output] Correctly caught exception: ${err.message}`);
            if (err.message.includes("Insufficient stock")) {
                console.log("✓ TEST 2 SUCCESS: Expired batches locked and excluded from sale!");
            } else {
                throw err;
            }
        }
    } catch (e) {
        console.error("✗ TEST 2 FAILED:", e.message);
        process.exit(1);
    }

    // ==========================================
    // TEST AREA 3: AUTO-DEDUCT TRIGGER & LEDGER LOGGING
    // ==========================================
    console.log("\n[TEST 3] Testing billing database transactions...");
    
    // Simulate checkout transaction via direct DB queries (mimicking app.js/server.js)
    try {
        conn.exec("BEGIN TRANSACTION;");
        
        const invoiceNumber = "INV-TEST-0001";
        conn.prepare(`
            INSERT INTO invoices (invoice_number, user_id, total_amount, payment_method)
            VALUES (?, 3, 0.0, 'CASH')
        `).run(invoiceNumber);
        const invoiceId = 1;
        
        // Sell 70 Paracetamol base units
        const allocs = allocateFEFOBatches(paraId, 70);
        let totalAmount = 0.0;
        
        for (const alloc of allocs) {
            const subtotal = alloc.quantity_allocated * alloc.selling_price;
            totalAmount += subtotal;
            
            // Insert item. This triggers trg_deduct_stock_on_sale!
            conn.prepare(`
                INSERT INTO invoice_items (invoice_id, product_id, batch_id, quantity_sold, unit_price, subtotal)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(invoiceId, paraId, alloc.batch_id, alloc.quantity_allocated, alloc.selling_price, subtotal);
            
            // Ledger entry
            conn.prepare(`
                INSERT INTO stock_ledger (product_id, batch_id, transaction_type, quantity_changed, reference_id, user_id)
                VALUES (?, ?, 'SALE', ?, ?, 3)
            `).run(paraId, alloc.batch_id, -alloc.quantity_allocated, invoiceNumber);
        }
        
        // Update Invoice Total
        conn.prepare("UPDATE invoices SET total_amount = ? WHERE id = ?").run(totalAmount, invoiceId);
        
        conn.exec("COMMIT;");
        console.log(`[Test 3 Output] Transaction committed. Invoice total: ₦${totalAmount}`);
        
        // Verify stock deduction from product_batches quantity_on_hand
        const batchSoon = conn.prepare("SELECT quantity_on_hand FROM product_batches WHERE batch_number = 'B-PARA-SOON'").get();
        const batchLate = conn.prepare("SELECT quantity_on_hand FROM product_batches WHERE batch_number = 'B-PARA-LATE'").get();
        
        console.log(`[Test 3 Output] B-PARA-SOON Qty Remaining: ${batchSoon.quantity_on_hand} (Expected: 0)`);
        console.log(`[Test 3 Output] B-PARA-LATE Qty Remaining: ${batchLate.quantity_on_hand} (Expected: 80)`);
        
        if (batchSoon.quantity_on_hand !== 0) throw new Error("Batch 'B-PARA-SOON' should be completely depleted (0).");
        if (batchLate.quantity_on_hand !== 80) throw new Error("Batch 'B-PARA-LATE' should have 80 units left.");
        
        // Verify ledger entries
        const salesLedgerCount = conn.prepare("SELECT COUNT(*) as count FROM stock_ledger WHERE transaction_type = 'SALE'").get().count;
        if (salesLedgerCount !== 2) throw new Error("Should have written exactly 2 stock_ledger sale records.");
        
        console.log("✓ TEST 3 SUCCESS: SQLite trigger decrements stock; ledger audits logged perfectly!");
    } catch (e) {
        conn.exec("ROLLBACK;");
        console.error("✗ TEST 3 FAILED:", e.message);
        process.exit(1);
    }

    // ==========================================
    // TEST AREA 4: ANALYTICS & REPORTS
    // ==========================================
    console.log("\n[TEST 4] Testing reports metrics queries...");
    try {
        // Near-Expiry: B-PARA-SOON expires in 30 days. Should appear in getNearExpiryAlerts().
        const nearExpiry = getNearExpiryAlerts();
        console.log(`[Test 4 Output] Near Expiry items found: ${nearExpiry.length}`);
        if (nearExpiry.length === 0) throw new Error("Near-expiry batch should be returned.");
        
        // Low Stock: Paracetamol reorder level is 30. Remaining active stock is 80 (B-PARA-LATE).
        // Let's check. Wait, sum of Paracetamol active/expired stock is 80 units + 80 expired = 160. But wait, getLowStockAlerts aggregates all stock (active + expired? or just active?).
        // In getLowStockAlerts query: SELECT SUM(b.quantity_on_hand) as total_quantity_on_hand FROM products LEFT JOIN product_batches...
        // Total Paracetamol units is 0 (soon) + 80 (late) + 80 (expired) = 160. Reorder level is 30. So Paracetamol is NOT low stock.
        // Morphine has 20 units. Reorder level is 5. Morphine is NOT low stock.
        // Let's insert a low stock product to verify!
        insertProduct.run(
            "Low Stock Drug", "Amlodipine", "SKU-AML-001", "700111222", 
            "Cardiovascular", "Tablet", "Box of 20", 1, 15, 0
        );
        insertBatch.run(3, "B-AML-01", expiryLate, 5, 2.0, 4.0, "Pfizer"); // 5 units < 15 reorder level
        
        const lowStock = getLowStockAlerts();
        console.log(`[Test 4 Output] Low Stock items found: ${lowStock.length} (Expected: 1)`);
        if (lowStock.length !== 1 || lowStock[0].product_name !== "Low Stock Drug") {
            throw new Error("Should report 'Low Stock Drug' in low stock alerts.");
        }

        // Dead Stock: Morphine was registered but has no sales. Paracetamol has sales.
        // getDeadStock should list Morphine and Low Stock Drug.
        const deadStock = getDeadStock();
        console.log(`[Test 4 Output] Dead Stock items found: ${deadStock.length}`);
        const deadNames = deadStock.map(p => p.product_name);
        console.log(`[Test 4 Output] Dead Stock names: ${deadNames.join(', ')}`);
        if (!deadNames.includes("Morphine Sulfate 10mg")) {
            throw new Error("Morphine should appear in dead stock analytics.");
        }

        // Daily Net Margin & COGS
        // We sold 50 units @ 3.0 (cost 1.5) and 20 units @ 2.8 (cost 1.4)
        // Total Revenue = (50 * 3.0) + (20 * 2.8) = 150 + 56 = 206
        // Total COGS = (50 * 1.5) + (20 * 1.4) = 75 + 28 = 103
        // Net Profit = 206 - 103 = 103
        const dailyMargins = getDailyMarginsReport();
        console.log("[Test 4 Output] Daily Margin Report:", JSON.stringify(dailyMargins, null, 2));
        if (dailyMargins.length === 0) throw new Error("Daily margins report should contain records.");
        if (dailyMargins[0].total_revenue !== 206 || dailyMargins[0].total_cogs !== 103 || dailyMargins[0].net_profit !== 103) {
            throw new Error("Calculations for revenue, cogs, or margins are incorrect.");
        }

        console.log("✓ TEST 4 SUCCESS: Analytics views and accounting metrics are 100% accurate!");
    } catch (e) {
        console.error("✗ TEST 4 FAILED:", e.message);
        process.exit(1);
    }

    // ==========================================
    // TEST AREA 5: HTTP AUTH & ROLE-BASED ACCESS CONTROL
    // ==========================================
    console.log("\n[TEST 5] Testing API authentication & RBAC...");
    let server;
    try {
        const bcrypt = require('bcryptjs');
        // Seed a known admin and a cashier for auth checks
        conn.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'ADMIN')")
            .run('t_admin', bcrypt.hashSync('adminpass', 10), 'Test Admin');
        conn.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'CASHIER')")
            .run('t_cashier', bcrypt.hashSync('cashierpass', 10), 'Test Cashier');

        const { app } = require('./server');
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = `http://127.0.0.1:${server.address().port}`;

        const call = (method, route, body, token) => new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const req = http.request(`${base}${route}`, { method, headers }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {}, contentType: res.headers['content-type'] }));
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });

        // 5a. Protected route without a token → 401
        const noAuth = await call('GET', '/api/products');
        if (noAuth.status !== 401) throw new Error(`Unauthenticated /api/products should be 401, got ${noAuth.status}`);
        console.log("✓ 5a: Unauthenticated request rejected (401).");

        // 5b. Bad credentials → 401
        const badLogin = await call('POST', '/api/auth/login', { username: 't_admin', password: 'wrong' });
        if (badLogin.status !== 401) throw new Error(`Bad login should be 401, got ${badLogin.status}`);
        console.log("✓ 5b: Invalid credentials rejected (401).");

        // 5c. Valid login → token issued
        const adminLogin = await call('POST', '/api/auth/login', { username: 't_admin', password: 'adminpass' });
        if (adminLogin.status !== 200 || !adminLogin.body.token) throw new Error("Admin login should return a token.");
        const adminToken = adminLogin.body.token;
        console.log("✓ 5c: Valid login issues a session token.");

        // 5d. Authenticated request → 200
        const withAuth = await call('GET', '/api/products', null, adminToken);
        if (withAuth.status !== 200) throw new Error(`Authenticated /api/products should be 200, got ${withAuth.status}`);
        console.log("✓ 5d: Authenticated request accepted (200).");

        // 5e. Cashier hitting an ADMIN-only route → 403
        const cashierLogin = await call('POST', '/api/auth/login', { username: 't_cashier', password: 'cashierpass' });
        const cashierToken = cashierLogin.body.token;
        const forbidden = await call('GET', '/api/users', null, cashierToken);
        if (forbidden.status !== 403) throw new Error(`Cashier /api/users should be 403, got ${forbidden.status}`);
        console.log("✓ 5e: Role guard blocks cashier from admin route (403).");

        // 5f. Unknown API route returns JSON 404 (not the SPA shell)
        const unknown = await call('GET', '/api/does-not-exist', null, adminToken);
        if (unknown.status !== 404 || !unknown.contentType.includes('application/json')) {
            throw new Error(`Unknown API route should be JSON 404, got ${unknown.status} ${unknown.contentType}`);
        }
        console.log("✓ 5f: Unknown API route returns JSON 404.");

        console.log("✓ TEST 5 SUCCESS: API auth and RBAC enforced correctly!");
    } catch (e) {
        console.error("✗ TEST 5 FAILED:", e.message);
        if (server) server.close();
        process.exit(1);
    }
    if (server) server.close();

    console.log("\n==========================================");
    console.log("ALL POS INTEGRATION TESTS PASSED SUCCESSFULLY!");
    console.log("==========================================");
    process.exit(0);
}

runTests();
