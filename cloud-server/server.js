const express = require('express');
const { usePostgres, pool, sqliteDb } = require('./db');
const app = express();

app.use(express.json());

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`[Cloud Sync API] Central Server active at http://localhost:${PORT}`);
});
