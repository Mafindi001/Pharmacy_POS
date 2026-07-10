const dns = require('dns');

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const { Client } = require('pg');

const connectionString = process.argv[2] || process.env.DATABASE_URL;

if (!connectionString) {
    console.error("Error: Please provide your Supabase Connection String.");
    console.error("Usage: node deploy-schema.js \"postgresql://postgres:password@host:port/database\"");
    process.exit(1);
}

const client = new Client({
    connectionString: connectionString,
    ssl: {
        rejectUnauthorized: false
    },
    stream: () => {
        const net = require('net');
        const socket = new net.Socket();
        const originalConnect = socket.connect;
        socket.connect = function(port, host, cb) {
            if (typeof port === 'object') {
                return originalConnect.call(this, { ...port, family: 4 }, cb);
            } else {
                return originalConnect.call(this, { port: port, host: host, family: 4 }, cb);
            }
        };
        return socket;
    }
});

const schemaSql = `
    -- 1. STORES TABLE
    CREATE TABLE IF NOT EXISTS stores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(255) UNIQUE NOT NULL,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        store_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. PRODUCTS TABLE
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER,
        tenant_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        product_name VARCHAR(255) NOT NULL,
        generic_name VARCHAR(255),
        sku VARCHAR(255),
        barcode VARCHAR(255),
        category VARCHAR(255) NOT NULL,
        form VARCHAR(255) NOT NULL,
        pack_size VARCHAR(255),
        base_unit_multiplier INTEGER DEFAULT 1,
        reorder_level INTEGER DEFAULT 10,
        is_prescription_required INTEGER DEFAULT 0,
        minimum_order_quantity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, id)
    );

    -- 3. PRODUCT BATCHES TABLE
    CREATE TABLE IF NOT EXISTS product_batches (
        id INTEGER,
        tenant_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER,
        batch_number VARCHAR(255) NOT NULL,
        expiry_date DATE NOT NULL,
        quantity_on_hand INTEGER NOT NULL,
        cost_price REAL NOT NULL,
        selling_price REAL NOT NULL,
        supplier_name VARCHAR(255),
        received_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, id)
    );

    -- 4. USERS TABLE
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER,
        tenant_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        username VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, id)
    );

    -- 5. INVOICES TABLE
    CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        tenant_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        invoice_number VARCHAR(255) NOT NULL,
        user_id INTEGER NOT NULL,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(255),
        total_amount REAL NOT NULL,
        payment_method VARCHAR(255) NOT NULL,
        doctor_name VARCHAR(255),
        doctor_license_number VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tenant_id, invoice_number)
    );

    -- 6. INVOICE ITEMS TABLE
    CREATE TABLE IF NOT EXISTS invoice_items (
        id SERIAL PRIMARY KEY,
        tenant_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        invoice_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        quantity_sold INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        subtotal REAL NOT NULL
    );

    -- Enable RLS
    ALTER TABLE products ENABLE ROW LEVEL SECURITY;
    ALTER TABLE product_batches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

    -- Create RLS Policies (Allow access if tenant_id matches the session variable)
    DROP POLICY IF EXISTS tenant_isolation_products ON products;
    CREATE POLICY tenant_isolation_products ON products 
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_batches ON product_batches;
    CREATE POLICY tenant_isolation_batches ON product_batches 
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_users ON users;
    CREATE POLICY tenant_isolation_users ON users 
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;
    CREATE POLICY tenant_isolation_invoices ON invoices 
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

    DROP POLICY IF EXISTS tenant_isolation_items ON invoice_items;
    CREATE POLICY tenant_isolation_items ON invoice_items 
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;

async function deploy() {
    console.log("[Supabase Deployer] Connecting to database...");
    try {
        await client.connect();
        console.log("[Supabase Deployer] Connection established. Running migrations schema...");
        await client.query(schemaSql);
        console.log("[Supabase Deployer] Schema and RLS policies created successfully!");
        process.exit(0);
    } catch (err) {
        console.error("[Supabase Deployer] Deployment failed:", err.message);
        process.exit(1);
    }
}

deploy();
