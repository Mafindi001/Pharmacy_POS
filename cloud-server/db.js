const path = require('path');
const fs = require('fs');
const dns = require('dns');

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

let usePostgres = false;
let pool = null;
let sqliteDb = null;

if (process.env.DATABASE_URL) {
    let dbUrl = process.env.DATABASE_URL;
    if (dbUrl.includes('sslmode=')) {
        dbUrl = dbUrl.replace(/sslmode=[^&]+/g, 'sslmode=no-verify');
    } else {
        const separator = dbUrl.includes('?') ? '&' : '?';
        dbUrl = dbUrl + separator + 'sslmode=no-verify';
    }

    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: dbUrl,
        ssl: {
            rejectUnauthorized: false
        },
        stream: () => {
            const net = require('net');
            const socket = new net.Socket();
            const originalConnect = socket.connect;
            socket.connect = function(port, host, cb) {
                const targetHost = typeof port === 'object' ? port.host : host;
                const targetPort = typeof port === 'object' ? port.port : port;
                const targetCb = typeof port === 'object' ? host : cb;

                if (targetHost && typeof targetHost === 'string') {
                    const dns = require('dns');
                    dns.lookup(targetHost, { family: 4 }, (err, address) => {
                        if (!err && address) {
                            return originalConnect.call(this, { port: targetPort, host: address, family: 4 }, targetCb);
                        } else {
                            return originalConnect.call(this, { port: targetPort, host: targetHost }, targetCb);
                        }
                    });
                    return this;
                } else {
                    if (typeof port === 'object') {
                        return originalConnect.call(this, port, cb);
                    } else {
                        return originalConnect.call(this, { port, host }, cb);
                    }
                }
            };
            return socket;
        }
    });
    usePostgres = true;
    console.log("[Cloud Database] Configured to connect to PostgreSQL central cluster.");
} else {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(__dirname, 'cloud_central.db');
    sqliteDb = new DatabaseSync(dbPath);
    console.log(`[Cloud Database] Fallback active: using local SQLite cluster at ${dbPath}`);
    
    // Create base tables in cloud fallback DB
    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS stores (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            api_key TEXT UNIQUE NOT NULL,
            store_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER,
            tenant_id TEXT,
            product_name TEXT NOT NULL,
            generic_name TEXT,
            sku TEXT,
            barcode TEXT,
            category TEXT NOT NULL,
            form TEXT NOT NULL,
            pack_size TEXT,
            base_unit_multiplier INTEGER DEFAULT 1,
            reorder_level INTEGER DEFAULT 10,
            is_prescription_required INTEGER DEFAULT 0,
            minimum_order_quantity INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, id)
        );

        CREATE TABLE IF NOT EXISTS product_batches (
            id INTEGER,
            tenant_id TEXT,
            product_id INTEGER,
            batch_number TEXT NOT NULL,
            expiry_date DATE NOT NULL,
            quantity_on_hand INTEGER NOT NULL,
            cost_price REAL NOT NULL,
            selling_price REAL NOT NULL,
            supplier_name TEXT,
            received_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, id)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER,
            tenant_id TEXT,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, id)
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            invoice_number TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            total_amount REAL NOT NULL,
            payment_method TEXT NOT NULL,
            doctor_name TEXT,
            doctor_license_number TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, invoice_number)
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            invoice_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            batch_id INTEGER NOT NULL,
            quantity_sold INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            subtotal REAL NOT NULL
        );
    `);
    
    // Seed default stores inside fallback
    const checkStore = sqliteDb.prepare("SELECT COUNT(*) as count FROM stores").get();
    if (checkStore.count === 0) {
        console.log("[Cloud Database] Seeding default store downtown-branch for testing...");
        const insertStore = sqliteDb.prepare("INSERT INTO stores (id, slug, api_key, store_name) VALUES (?, ?, ?, ?)");
        // Tenant UUID, store slug, api_key (store-token-123), store name
        insertStore.run('11111111-1111-1111-1111-111111111111', 'downtown-branch', 'store-token-123', 'RxPOS Downtown Branch');
    }
}

// Enforces tenant context query execution
async function runTenantQuery(tenantId, queryText, queryParams = []) {
    if (usePostgres) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN;');
            await client.query(`SET LOCAL app.current_tenant_id = $1;`, [tenantId]);
            const res = await client.query(queryText, queryParams);
            await client.query('COMMIT;');
            return res.rows;
        } catch (err) {
            await client.query('ROLLBACK;');
            throw err;
        } finally {
            client.release();
        }
    } else {
        // Fallback execution using SQLite
        const stmt = sqliteDb.prepare(queryText);
        const rows = stmt.all(...queryParams);
        return rows;
    }
}

module.exports = {
    usePostgres,
    pool,
    sqliteDb,
    runTenantQuery
};
