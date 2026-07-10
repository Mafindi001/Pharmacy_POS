const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');

// 1. DATABASE LOCALIZATION & PATH RESOLUTION
let dbDir;
if (process.platform === 'win32') {
    dbDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pharmacy-pos');
} else if (process.platform === 'darwin') {
    dbDir = path.join(os.homedir(), 'Library', 'Application Support', 'pharmacy-pos');
} else {
    dbDir = path.join(os.homedir(), '.local', 'share', 'pharmacy-pos');
}

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'inventory.db');
console.log(`[Database] Localization Path: ${dbPath}`);

// Initialize connection
let db;

function getDbConnection() {
    if (!db) {
        db = new DatabaseSync(dbPath);
        // Force foreign keys check instantly on connection!
        db.exec('PRAGMA foreign_keys = ON;');
    }
    return db;
}

// 2. SCHEMA INITIALIZATION & SEED DATA
function initDatabase() {
    const conn = getDbConnection();

    // Create Tables
    conn.exec(`
        -- 1. USER ACCOUNTS & PRIVILEGES
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, 
            full_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('ADMIN', 'PHARMACIST', 'CASHIER', 'SALES', 'ACCOUNTING')),
            is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 2. CORE PRODUCT REGISTRY
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT NOT NULL,
            generic_name TEXT,              
            sku TEXT UNIQUE,                
            barcode TEXT UNIQUE,            
            category TEXT NOT NULL,         
            form TEXT NOT NULL,             
            pack_size TEXT,                 
            base_unit_multiplier INTEGER DEFAULT 1 CHECK (base_unit_multiplier > 0),
            reorder_level INTEGER DEFAULT 10 CHECK (reorder_level >= 0),
            is_prescription_required INTEGER DEFAULT 0 CHECK (is_prescription_required IN (0, 1)),
            minimum_order_quantity INTEGER DEFAULT 1 CHECK (minimum_order_quantity >= 1),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 3. BATCH & EXPIRY TRACKING INVENTORY
        CREATE TABLE IF NOT EXISTS product_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            batch_number TEXT NOT NULL,
            expiry_date DATE NOT NULL,      
            quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0), 
            cost_price REAL NOT NULL CHECK (cost_price >= 0.0),    
            selling_price REAL NOT NULL CHECK (selling_price >= 0.0), 
            supplier_name TEXT,
            received_date DATE DEFAULT (DATE('now')),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
            UNIQUE (product_id, batch_number)
        );

        -- 4. SALES INVOICING
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT NOT NULL UNIQUE, 
            user_id INTEGER NOT NULL,            
            customer_name TEXT DEFAULT 'Walk-in Customer',
            customer_phone TEXT,
            total_amount REAL NOT NULL DEFAULT 0.0 CHECK (total_amount >= 0.0),
            payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'CARD', 'MOBILE_TRANSFER')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            doctor_name TEXT,
            doctor_license_number TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            batch_id INTEGER NOT NULL,
            quantity_sold INTEGER NOT NULL CHECK (quantity_sold > 0), 
            unit_price REAL NOT NULL CHECK (unit_price >= 0.0),
            subtotal REAL NOT NULL CHECK (subtotal >= 0.0),
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON DELETE RESTRICT
        );

        -- 5. READ-ONLY AUDIT LEDGER
        CREATE TABLE IF NOT EXISTS stock_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            batch_id INTEGER NOT NULL,
            transaction_type TEXT NOT NULL CHECK (
                transaction_type IN ('INITIAL_STOCK', 'SALE', 'PURCHASE_RETURN', 'SUPPLIER_RESTOCK', 'EXPIRED_WASTE', 'DAMAGED_WASTE', 'MANUAL_AUDIT')
            ),
            quantity_changed INTEGER NOT NULL, 
            reference_id TEXT,                 
            user_id INTEGER NOT NULL,          
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON DELETE RESTRICT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
        );

        -- INDEXES FOR INSTANT OFFLINE EXECUTION
        CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
        CREATE INDEX IF NOT EXISTS idx_products_names ON products(product_name, generic_name);
        CREATE INDEX IF NOT EXISTS idx_batches_expiry ON product_batches(expiry_date);
        CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_id);
    `);

    // Create deducting stock trigger
    conn.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_deduct_stock_on_sale
        AFTER INSERT ON invoice_items
        BEGIN
            UPDATE product_batches
            SET quantity_on_hand = quantity_on_hand - NEW.quantity_sold
            WHERE id = NEW.batch_id;
        END;
    `);

    // Migration: Update users table check constraint if old schema exists
    try {
        const masterSql = conn.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
        if (masterSql && !masterSql.sql.includes('SALES')) {
            console.log("[Database] Migrating users table check constraint to support new roles...");
            conn.exec("BEGIN TRANSACTION;");
            conn.exec("ALTER TABLE users RENAME TO users_old;");
            conn.exec(`
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL, 
                    full_name TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'PHARMACIST', 'CASHIER', 'SALES', 'ACCOUNTING')),
                    is_active INTEGER DEFAULT 1 CHECK (is_active IN (0, 1)),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            conn.exec("INSERT INTO users (id, username, password_hash, full_name, role, is_active, created_at) SELECT id, username, password_hash, full_name, role, is_active, created_at FROM users_old;");
            conn.exec("DROP TABLE users_old;");
            conn.exec("COMMIT;");
            console.log("[Database] Users table migrated successfully.");
        }
    } catch (e) {
        console.error("[Database] Migration of users table failed: ", e);
        try { conn.exec("ROLLBACK;"); } catch(_) {}
    }

    // Seed default users if users table is empty
    const checkUsers = conn.prepare("SELECT COUNT(*) as count FROM users").get();
    if (checkUsers.count === 0) {
        console.log("[Database] Seeding default accounts...");
        const insertUser = conn.prepare(`
            INSERT INTO users (username, password_hash, full_name, role)
            VALUES (?, ?, ?, ?)
        `);

        // Seed Admin, Pharmacist, Cashier
        insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'Admin Supervisor', 'ADMIN');
        insertUser.run('pharmacist', bcrypt.hashSync('rx123', 10), 'Registered Pharmacist', 'PHARMACIST');
        insertUser.run('cashier', bcrypt.hashSync('cash123', 10), 'Store Cashier', 'CASHIER');
        console.log("[Database] Accounts seeded successfully.");
    }

    // Schema migrations: add minimum_order_quantity column to products table if missing
    try {
        conn.exec("ALTER TABLE products ADD COLUMN minimum_order_quantity INTEGER DEFAULT 1 CHECK (minimum_order_quantity >= 1);");
        console.log("[Database] Migrated schema: added minimum_order_quantity column.");
    } catch (e) {
        // Already exists
    }

    // Schema migrations: initialize sync queue and tenant settings configuration tables
    try {
        conn.exec(`
            CREATE TABLE IF NOT EXISTS sync_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                action_type TEXT NOT NULL CHECK(action_type IN ('INSERT', 'UPDATE', 'DELETE')),
                payload TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'failed')),
                error_message TEXT
            );

            CREATE TABLE IF NOT EXISTS system_config (
                config_key TEXT PRIMARY KEY,
                config_value TEXT
            );
        `);
        
        // Seed system configuration defaults if empty
        const configCount = conn.prepare("SELECT COUNT(*) as count FROM system_config").get();
        if (configCount.count === 0) {
            console.log("[Database] Initializing sync system configurations...");
            const insertConfig = conn.prepare("INSERT INTO system_config (config_key, config_value) VALUES (?, ?)");
            insertConfig.run('store_slug', '');
            insertConfig.run('sync_api_key', '');
            insertConfig.run('cloud_url', 'http://localhost:5000');
            insertConfig.run('last_sync_timestamp', '1970-01-01 00:00:00');
        }
        console.log("[Database] Sync system tables initialized successfully.");
    } catch (e) {
        console.error("[Database] Failed to initialize sync tables: ", e);
    }
}

// 3. CORE INVENTORY / BUSINESS LOGIC

/**
 * FEFO (First-Expired, First-Out) Batch Selection & Allocation Algorithm.
 * Returns allocation chunks or throws an error if total quantity is insufficient.
 */
function allocateFEFOBatches(productId, quantity) {
    const conn = getDbConnection();
    
    // Select all active batches (not expired, qty > 0) sorted by closest expiry
    const selectBatchesQuery = conn.prepare(`
        SELECT id, batch_number, expiry_date, quantity_on_hand, selling_price
        FROM product_batches
        WHERE product_id = ? 
          AND quantity_on_hand > 0 
          AND expiry_date > DATE('now')
        ORDER BY expiry_date ASC
    `);
    
    const activeBatches = selectBatchesQuery.all(productId);
    
    let remainingToAllocate = quantity;
    const allocations = [];
    
    for (const batch of activeBatches) {
        if (remainingToAllocate <= 0) break;
        
        const take = Math.min(batch.quantity_on_hand, remainingToAllocate);
        allocations.push({
            batch_id: batch.id,
            batch_number: batch.batch_number,
            quantity_allocated: take,
            selling_price: batch.selling_price,
            expiry_date: batch.expiry_date
        });
        remainingToAllocate -= take;
    }
    
    if (remainingToAllocate > 0) {
        throw new Error(`Insufficient stock for product ID ${productId}. Short by ${remainingToAllocate} units.`);
    }
    
    return allocations;
}

/**
 * Validates supervisor password and checks if the role is ADMIN or PHARMACIST.
 */
function verifySupervisorOverride(username, password) {
    const conn = getDbConnection();
    const userQuery = conn.prepare(`
        SELECT password_hash, role 
        FROM users 
        WHERE username = ? AND is_active = 1
    `);
    const user = userQuery.get(username);
    
    if (!user) return { success: false, message: "User not found" };
    if (user.role !== 'ADMIN' && user.role !== 'PHARMACIST') {
        return { success: false, message: "Unauthorized role for override" };
    }
    
    const isValid = bcrypt.compareSync(password, user.password_hash);
    return { success: isValid, message: isValid ? "Authorized" : "Invalid password" };
}

// 4. REPORTING & ANALYTICS QUERIES

/**
 * Module 3, Query 1: Near-Expiry Alerts View (<= 120 days from now)
 */
function getNearExpiryAlerts() {
    const conn = getDbConnection();
    return conn.prepare(`
        SELECT b.id, b.batch_number, b.expiry_date, b.quantity_on_hand, b.selling_price,
               p.product_name, p.generic_name, p.form, p.sku
        FROM product_batches b
        JOIN products p ON b.product_id = p.id
        WHERE b.expiry_date <= DATE('now', '+120 days')
          AND b.quantity_on_hand > 0
        ORDER BY b.expiry_date ASC
    `).all();
}

/**
 * Module 3, Query 2: Low-Stock Alert Processing
 * Aggregates collective quantity across all batches and compares to reorder_level.
 */
function getLowStockAlerts() {
    const conn = getDbConnection();
    return conn.prepare(`
        SELECT p.id, p.product_name, p.generic_name, p.sku, p.reorder_level, p.pack_size, p.base_unit_multiplier,
               IFNULL(SUM(b.quantity_on_hand), 0) as total_quantity_on_hand
        FROM products p
        LEFT JOIN product_batches b ON p.id = b.product_id
        GROUP BY p.id
        HAVING total_quantity_on_hand < p.reorder_level
        ORDER BY total_quantity_on_hand ASC
    `).all();
}

/**
 * Module 3, Query 3: Dead Stock Identification Analytics
 * Products that have not appeared inside any invoice_items records within a 90-day window.
 */
function getDeadStock() {
    const conn = getDbConnection();
    return conn.prepare(`
        SELECT p.id, p.product_name, p.generic_name, p.sku, p.category,
               IFNULL(SUM(b.quantity_on_hand), 0) as total_quantity_on_hand
        FROM products p
        LEFT JOIN product_batches b ON p.id = b.product_id
        WHERE p.id NOT IN (
            SELECT DISTINCT ii.product_id 
            FROM invoice_items ii
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE i.created_at >= DATE('now', '-90 days')
        )
        GROUP BY p.id
        ORDER BY total_quantity_on_hand DESC
    `).all();
}

/**
 * Module 3, Query 4: Daily Net Margin & COGS Report
 * Groups sales daily, computing total revenue, COGS, and profit.
 */
function getDailyMarginsReport() {
    const conn = getDbConnection();
    return conn.prepare(`
        SELECT DATE(i.created_at) as sales_date,
               COUNT(DISTINCT i.id) as invoice_count,
               SUM(ii.quantity_sold * ii.unit_price) as total_revenue,
               SUM(ii.quantity_sold * b.cost_price) as total_cogs,
               SUM(ii.quantity_sold * ii.unit_price) - SUM(ii.quantity_sold * b.cost_price) as net_profit
        FROM invoices i
        JOIN invoice_items ii ON i.id = ii.invoice_id
        JOIN product_batches b ON ii.batch_id = b.id
        GROUP BY sales_date
        ORDER BY sales_date DESC
    `).all();
}

module.exports = {
    getDbConnection,
    initDatabase,
    allocateFEFOBatches,
    verifySupervisorOverride,
    getNearExpiryAlerts,
    getLowStockAlerts,
    getDeadStock,
    getDailyMarginsReport,
    dbPath
};
