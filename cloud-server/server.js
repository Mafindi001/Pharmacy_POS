const express = require('express');
const { usePostgres, pool, sqliteDb } = require('./db');
const app = express();

app.use(express.json());

// Root Gateway Status Page
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>RxPOS Sync Engine</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #07070e; color: #f0f0f5; text-align: center; padding-top: 100px; }
                    .badge { background: #10b981; color: #07070e; padding: 6px 12px; border-radius: 20px; font-weight: bold; font-size: 0.9rem; }
                    h1 { font-weight: 600; font-size: 2.2rem; }
                    p { color: #9ca3af; font-size: 1.1rem; }
                </style>
            </head>
            <body>
                <h1>RxPOS Multi-Tenant Sync Gateway</h1>
                <p>Status: <span class="badge">Online</span></p>
                <p style="font-size: 0.9rem; margin-top: 20px;">Secure data synchronization engine for active POS clients.</p>
            </body>
        </html>
    `);
});

// Multi-tenant Authentication Middleware
async function authenticateStore(req, res, next) {
    const apiKey = req.headers['x-store-api-key'];
    const storeSlug = req.headers['x-store-slug'];
    
    if (!apiKey || !storeSlug) {
        return res.status(401).json({ error: "Unauthorized. Missing store API key or slug headers." });
    }
    
    try {
        let storeRecord;
        if (usePostgres) {
            const query = "SELECT id, store_name FROM stores WHERE slug = $1 AND api_key = $2";
            const result = await pool.query(query, [storeSlug, apiKey]);
            storeRecord = result.rows[0];
        } else {
            const stmt = sqliteDb.prepare("SELECT id, store_name FROM stores WHERE slug = ? AND api_key = ?");
            storeRecord = stmt.get(storeSlug, apiKey);
        }
        
        if (!storeRecord) {
            return res.status(403).json({ error: "Forbidden. Invalid store API credentials." });
        }
        
        req.tenant_id = storeRecord.id;
        req.store_name = storeRecord.store_name;
        next();
    } catch (err) {
        res.status(500).json({ error: "Auth internal error: " + err.message });
    }
}

// 1. PUSH ENDPOINT: Receives local store checkout checkouts
app.post('/api/sync/push', authenticateStore, async (req, res) => {
    const { events } = req.body;
    const tenantId = req.tenant_id;
    
    if (!events || !Array.isArray(events)) {
        return res.status(400).json({ error: "Invalid sync events payload." });
    }
    
    const syncedIds = [];
    
    try {
        if (usePostgres) {
            // Postgres push transaction
            const client = await pool.connect();
            try {
                await client.query('BEGIN;');
                for (const ev of events) {
                    if (ev.table_name === 'invoices' && ev.action_type === 'INSERT') {
                        const invoice = JSON.parse(ev.payload);
                        
                        // Insert invoice parent record
                        const insertInvSql = `
                            INSERT INTO invoices (tenant_id, invoice_number, user_id, customer_name, customer_phone, total_amount, payment_method, doctor_name, doctor_license_number, created_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                            ON CONFLICT (tenant_id, invoice_number) DO NOTHING;
                        `;
                        await client.query(insertInvSql, [
                            tenantId, invoice.invoice_number, invoice.user_id, invoice.customer_name,
                            invoice.customer_phone, invoice.total_amount, invoice.payment_method,
                            invoice.doctor_name, invoice.doctor_license_number, invoice.created_at
                        ]);
                        
                        // Insert invoice children items
                        if (invoice.items && Array.isArray(invoice.items)) {
                            const insertItemSql = `
                                INSERT INTO invoice_items (tenant_id, invoice_id, product_id, batch_id, quantity_sold, unit_price, subtotal)
                                VALUES ($1, (SELECT id FROM invoices WHERE tenant_id = $1 AND invoice_number = $2), $3, $4, $5, $6, $7)
                            `;
                            for (const item of invoice.items) {
                                await client.query(insertItemSql, [
                                    tenantId, invoice.invoice_number, item.product_id, item.batch_id,
                                    item.quantity_sold, item.unit_price, item.subtotal
                                ]);
                            }
                        }
                        syncedIds.push(ev.id);
                    }
                }
                await client.query('COMMIT;');
            } catch (err) {
                await client.query('ROLLBACK;');
                throw err;
            } finally {
                client.release();
            }
        } else {
            // SQLite push fallback transaction
            sqliteDb.exec("BEGIN TRANSACTION;");
            try {
                const insertInv = sqliteDb.prepare(`
                    INSERT OR IGNORE INTO invoices (tenant_id, invoice_number, user_id, customer_name, customer_phone, total_amount, payment_method, doctor_name, doctor_license_number, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                
                const insertItem = sqliteDb.prepare(`
                    INSERT INTO invoice_items (tenant_id, invoice_id, product_id, batch_id, quantity_sold, unit_price, subtotal)
                    VALUES (?, (SELECT id FROM invoices WHERE tenant_id = ? AND invoice_number = ?), ?, ?, ?, ?, ?)
                `);
                
                for (const ev of events) {
                    if (ev.table_name === 'invoices' && ev.action_type === 'INSERT') {
                        const invoice = JSON.parse(ev.payload);
                        
                        insertInv.run(
                            tenantId, invoice.invoice_number, invoice.user_id, invoice.customer_name,
                            invoice.customer_phone, invoice.total_amount, invoice.payment_method,
                            invoice.doctor_name, invoice.doctor_license_number, invoice.created_at
                        );
                        
                        if (invoice.items && Array.isArray(invoice.items)) {
                            for (const item of invoice.items) {
                                insertItem.run(
                                    tenantId, tenantId, invoice.invoice_number, item.product_id, item.batch_id,
                                    item.quantity_sold, item.unit_price, item.subtotal
                                );
                            }
                        }
                        syncedIds.push(ev.id);
                    }
                }
                sqliteDb.exec("COMMIT;");
            } catch (err) {
                sqliteDb.exec("ROLLBACK;");
                throw err;
            }
        }
        
        console.log(`[Cloud Sync] Pushed checkouts successfully for store: ${req.store_name}. Synced ids count: ${syncedIds.length}`);
        res.json({ success: true, synced_ids: syncedIds });
    } catch (err) {
        console.error("[Cloud Sync] Push failure:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. PULL ENDPOINT: Sends database modifications to the local POS
app.get('/api/sync/pull', authenticateStore, async (req, res) => {
    const { since } = req.query;
    const tenantId = req.tenant_id;
    
    if (!since) {
        return res.status(400).json({ error: "Missing since parameter." });
    }
    
    const serverTimestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    try {
        let products = [];
        let productBatches = [];
        let users = [];
        
        if (usePostgres) {
            const prodSql = "SELECT * FROM products WHERE tenant_id = $1 AND updated_at > $2";
            const batchSql = "SELECT * FROM product_batches WHERE tenant_id = $1 AND updated_at > $2";
            const userSql = "SELECT * FROM users WHERE tenant_id = $1 AND updated_at > $2";
            
            const rProds = await pool.query(prodSql, [tenantId, since]);
            const rBatches = await pool.query(batchSql, [tenantId, since]);
            const rUsers = await pool.query(userSql, [tenantId, since]);
            
            products = rProds.rows;
            productBatches = rBatches.rows;
            users = rUsers.rows;
        } else {
            const prodSql = "SELECT * FROM products WHERE tenant_id = ? AND updated_at > ?";
            const batchSql = "SELECT * FROM product_batches WHERE tenant_id = ? AND updated_at > ?";
            const userSql = "SELECT * FROM users WHERE tenant_id = ? AND updated_at > ?";
            
            products = sqliteDb.prepare(prodSql).all(tenantId, since);
            productBatches = sqliteDb.prepare(batchSql).all(tenantId, since);
            users = sqliteDb.prepare(userSql).all(tenantId, since);
        }
        
        const hasUpdates = (products.length > 0 || productBatches.length > 0 || users.length > 0);
        res.json({
            has_updates: hasUpdates,
            products,
            product_batches: productBatches,
            users,
            server_timestamp: serverTimestamp
        });
    } catch (err) {
        console.error("[Cloud Sync] Pull failure:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. MOCK UTILITY ROUTE: Add mock drugs or edit drug price on cloud server to test bidirectional sync
app.post('/api/admin/mock-product-price-change', async (req, res) => {
    const { slug, api_key, product_id, new_price, new_cost } = req.body;
    
    if (!slug || !api_key || !product_id || !new_price) {
        return res.status(400).json({ error: "Missing required properties." });
    }
    
    try {
        let store;
        if (usePostgres) {
            const r = await pool.query("SELECT id FROM stores WHERE slug = $1 AND api_key = $2", [slug, api_key]);
            store = r.rows[0];
        } else {
            store = sqliteDb.prepare("SELECT id FROM stores WHERE slug = ? AND api_key = ?").get(slug, api_key);
        }
        
        if (!store) {
            return res.status(403).json({ error: "Invalid store authentication slug/token." });
        }
        
        const tenantId = store.id;
        const serverTimestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        
        if (usePostgres) {
            // Update PostgreSQL record
            await pool.query(
                "UPDATE product_batches SET selling_price = $1, cost_price = $2, updated_at = $3 WHERE tenant_id = $4 AND product_id = $5",
                [new_price, new_cost || 0.0, serverTimestamp, tenantId, product_id]
            );
        } else {
            // Update fallback SQLite record
            // First check if product exists inside mock
            const p = sqliteDb.prepare("SELECT id FROM products WHERE tenant_id = ? AND id = ?").get(tenantId, product_id);
            if (!p) {
                // Insert a dummy mock product
                sqliteDb.prepare(`
                    INSERT INTO products (id, tenant_id, product_name, generic_name, sku, barcode, category, form, base_unit_multiplier, reorder_level, is_prescription_required, minimum_order_quantity, updated_at)
                    VALUES (?, ?, 'Mock Synced Insulin', 'Insulin Glargine', 'SKU-SYNC-101', '1234567890123', 'Antidiabetics', 'Injection', 1, 5, 1, 1, ?)
                `).run(product_id, serverTimestamp);
            }
            
            // Upsert a batch for this product with updated selling price
            sqliteDb.prepare(`
                INSERT OR REPLACE INTO product_batches (id, tenant_id, product_id, batch_number, expiry_date, quantity_on_hand, cost_price, selling_price, supplier_name, received_date, updated_at)
                VALUES (999, ?, ?, 'BATCH-INIT', '2028-12-31', 100, ?, ?, 'Mock Cloud Supplier', '2026-07-10', ?)
            `).run(tenantId, product_id, new_cost || 10.0, new_price, serverTimestamp);
        }
        
        console.log(`[Cloud Mock Admin] Successfully simulated cloud database price change to ₦${new_price} for product ID ${product_id}`);
        res.json({ success: true, message: `Cloud database updated selling_price = ₦${new_price} for product ${product_id}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin panel credentials environment resolver
const ADMIN_USER = process.env.CLOUD_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.CLOUD_ADMIN_PASS || 'admin123';
const ADMIN_TOKEN = 'secret_token_session_rxmanager_2026';

// Helper Admin auth middleware
function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized. Missing authorization token." });
    }
    const token = authHeader.split(' ')[1];
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "Forbidden. Invalid administrator session." });
    }
    next();
}

// POST /api/admin/login (Verify admin password and return token)
app.post('/api/admin/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        res.json({ success: true, token: ADMIN_TOKEN });
    } else {
        res.status(401).json({ error: "Invalid administrator credentials." });
    }
});

// GET /api/admin/stores (Fetch all provisioned stores)
app.get('/api/admin/stores', authenticateAdmin, async (req, res) => {
    try {
        if (usePostgres) {
            const result = await pool.query("SELECT id, slug, api_key, store_name, created_at FROM stores ORDER BY created_at DESC");
            res.json(result.rows);
        } else {
            const rows = sqliteDb.prepare("SELECT id, slug, api_key, store_name, created_at FROM stores ORDER BY created_at DESC").all();
            res.json(rows);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/stores (Provision a new store and generate UUID/API Key)
app.post('/api/admin/stores', authenticateAdmin, async (req, res) => {
    const { name, slug } = req.body;
    if (!name || !slug) {
        return res.status(400).json({ error: "Missing store name or slug." });
    }
    
    const crypto = require('crypto');
    const tenantId = crypto.randomUUID();
    const apiKey = 'rxpos_' + crypto.randomBytes(24).toString('hex');
    
    try {
        if (usePostgres) {
            await pool.query(
                "INSERT INTO stores (id, slug, api_key, store_name) VALUES ($1, $2, $3, $4)",
                [tenantId, slug.trim(), apiKey, name.trim()]
            );
        } else {
            const stmt = sqliteDb.prepare("INSERT INTO stores (id, slug, api_key, store_name) VALUES (?, ?, ?, ?)");
            stmt.run(tenantId, slug.trim(), apiKey, name.trim());
        }
        res.json({ success: true, tenant_id: tenantId, api_key: apiKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/stores/:id (Revoke and delete store terminal access)
app.delete('/api/admin/stores/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        if (usePostgres) {
            await pool.query("DELETE FROM stores WHERE id = $1", [id]);
        } else {
            sqliteDb.prepare("DELETE FROM stores WHERE id = ?").run(id);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin (Serve the Admin Web Dashboard UI)
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>RxPOS Cloud Admin Panel</title>
            <style>
                :root {
                    --bg: #07070e;
                    --card: #12121e;
                    --border: rgba(255,255,255,0.08);
                    --primary: #06b6d4;
                    --primary-hover: #0891b2;
                    --ink: #f0f0f5;
                    --muted: #9ca3af;
                    --danger: #ef4444;
                }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    background-color: var(--bg);
                    color: var(--ink);
                    margin: 0;
                    padding: 24px;
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                    min-height: 100vh;
                }
                .container {
                    width: 100%;
                    max-width: 900px;
                }
                .card {
                    background-color: var(--card);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    padding: 24px;
                    margin-bottom: 24px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                }
                h1, h2, h3 { margin-top: 0; color: #fff; }
                .input-group {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    margin-bottom: 16px;
                }
                label { font-size: 0.85rem; font-weight: 600; color: var(--muted); }
                input {
                    background-color: rgba(0,0,0,0.3);
                    border: 1px solid var(--border);
                    color: var(--ink);
                    padding: 10px 14px;
                    border-radius: 8px;
                    outline: none;
                    font-size: 0.95rem;
                }
                input:focus { border-color: var(--primary); }
                .btn {
                    background-color: var(--primary);
                    color: var(--bg);
                    border: none;
                    padding: 12px 20px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 0.95rem;
                }
                .btn:hover { background-color: var(--primary-hover); }
                .btn.danger { background-color: var(--danger); color: #fff; }
                .hide { display: none !important; }
                .error-msg { color: var(--danger); font-size: 0.85rem; margin-bottom: 12px; font-weight: 600; }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 16px;
                }
                th, td {
                    text-align: left;
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--border);
                }
                th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; }
                td { font-size: 0.9rem; }
                .copyable {
                    font-family: monospace;
                    background: rgba(255,255,255,0.05);
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    user-select: all;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <!-- LOGIN CARD -->
                <div id="login-card" class="card">
                    <h2>RxPOS Admin Gateway</h2>
                    <p style="color: var(--muted); font-size: 0.9rem; margin-bottom: 20px;">Enter credentials to configure store terminal instances.</p>
                    <div id="login-error" class="error-msg hide"></div>
                    <form id="login-form">
                        <div class="input-group">
                            <label>Username</label>
                            <input type="text" id="admin-user" required placeholder="Enter admin username...">
                        </div>
                        <div class="input-group">
                            <label>Password</label>
                            <input type="password" id="admin-pass" required placeholder="Enter admin password...">
                        </div>
                        <button type="submit" class="btn">Login Console</button>
                    </form>
                </div>

                <!-- DASHBOARD CARD -->
                <div id="dashboard-card" class="card hide">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h2>Store Terminals Management</h2>
                        <button onclick="logout()" class="btn danger" style="padding: 6px 12px; font-size: 0.85rem;">Logout</button>
                    </div>
                    
                    <!-- Provision Store Form -->
                    <div class="card" style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 8px;">
                        <h3>Provision New Store Terminal</h3>
                        <form id="provision-form" style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end;">
                            <div class="input-group" style="margin: 0;">
                                <label>Store Name</label>
                                <input type="text" id="store-name" required placeholder="e.g. Downtown Branch">
                            </div>
                            <div class="input-group" style="margin: 0;">
                                <label>Store Slug</label>
                                <input type="text" id="store-slug" required placeholder="e.g. downtown-rx">
                            </div>
                            <button type="submit" class="btn" style="height: 42px;">Provision Key</button>
                        </form>
                        <div id="provision-error" class="error-msg hide" style="margin-top: 10px;"></div>
                    </div>

                    <!-- Stores Listing Table -->
                    <h3>Registered Store Terminals</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Store Name</th>
                                <th>Slug</th>
                                <th>API Key (Click to Copy)</th>
                                <th>Tenant ID</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody id="stores-tbody">
                            <!-- Filled dynamically -->
                        </tbody>
                    </table>
                </div>
            </div>

            <script>
                let authToken = localStorage.getItem('admin_token');

                document.getElementById('login-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const user = document.getElementById('admin-user').value;
                    const pass = document.getElementById('admin-pass').value;
                    const errorDiv = document.getElementById('login-error');
                    
                    try {
                        const res = await fetch('/api/admin/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ user, pass })
                        });
                        if (res.ok) {
                            const data = await res.json();
                            authToken = data.token;
                            localStorage.setItem('admin_token', authToken);
                            showDashboard();
                        } else {
                            const data = await res.json();
                            errorDiv.textContent = data.error || "Login failed.";
                            errorDiv.classList.remove('hide');
                        }
                    } catch(err) {
                        errorDiv.textContent = "Error: " + err.message;
                        errorDiv.classList.remove('hide');
                    }
                });

                document.getElementById('provision-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const name = document.getElementById('store-name').value.trim();
                    const slug = document.getElementById('store-slug').value.trim();
                    const errorDiv = document.getElementById('provision-error');
                    errorDiv.classList.add('hide');

                    try {
                        const res = await fetch('/api/admin/stores', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + authToken
                            },
                            body: JSON.stringify({ name, slug })
                        });
                        if (res.ok) {
                            document.getElementById('store-name').value = '';
                            document.getElementById('store-slug').value = '';
                            loadStores();
                        } else {
                            const data = await res.json();
                            errorDiv.textContent = data.error || "Provisioning failed.";
                            errorDiv.classList.remove('hide');
                        }
                    } catch(err) {
                        errorDiv.textContent = "Error: " + err.message;
                        errorDiv.classList.remove('hide');
                    }
                });

                async function loadStores() {
                    const tbody = document.getElementById('stores-tbody');
                    try {
                        const res = await fetch('/api/admin/stores', {
                            headers: { 'Authorization': 'Bearer ' + authToken }
                        });
                        if (res.status === 401 || res.status === 403) {
                            logout();
                            return;
                        }
                        const data = await res.json();
                        if (!res.ok) {
                            tbody.innerHTML = \`<tr><td colspan="5" style="text-align: center; color: var(--danger);">Failed to load terminals: \${data.error || 'Unknown error'}</td></tr>\`;
                            return;
                        }
                        tbody.innerHTML = '';
                        if (data.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--muted);">No store terminals provisioned yet.</td></tr>';
                            return;
                        }
                        data.forEach(s => {
                            const tr = document.createElement('tr');
                            tr.innerHTML = \`
                                <td><strong>\${s.store_name}</strong></td>
                                <td><span style="color: var(--primary);">\${s.slug}</span></td>
                                <td><span class="copyable" onclick="navigator.clipboard.writeText('\${s.api_key}'); alert('API Key copied!');">\${s.api_key} [Copy]</span></td>
                                <td><span style="font-family: monospace; font-size: 0.8rem;">\${s.id}</span></td>
                                <td><button class="btn danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteStore('\${s.id}')">Delete</button></td>
                            \`;
                            tbody.appendChild(tr);
                        });
                    } catch(err) {
                        tbody.innerHTML = \`<tr><td colspan="5" style="text-align: center; color: var(--danger);">Failed to load terminals: \${err.message}</td></tr>\`;
                    }
                }

                async function deleteStore(id) {
                    if (!confirm("Are you sure you want to delete and revoke this store terminal?")) return;
                    try {
                        const res = await fetch('/api/admin/stores/' + id, {
                            method: 'DELETE',
                            headers: { 'Authorization': 'Bearer ' + authToken }
                        });
                        if (res.ok) {
                            loadStores();
                        } else {
                            const data = await res.json();
                            alert("Failed to delete store: " + data.error);
                        }
                    } catch(err) {
                        alert("Error: " + err.message);
                    }
                }

                function showDashboard() {
                    document.getElementById('login-card').classList.add('hide');
                    document.getElementById('dashboard-card').classList.remove('hide');
                    loadStores();
                }

                function logout() {
                    localStorage.removeItem('admin_token');
                    authToken = null;
                    document.getElementById('login-card').classList.remove('hide');
                    document.getElementById('dashboard-card').classList.add('hide');
                }

                if (authToken) {
                    showDashboard();
                }
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`[Cloud Sync API] Central Server active at http://localhost:${PORT}`);
});
