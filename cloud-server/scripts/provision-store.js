const crypto = require('crypto');
const { usePostgres, pool, sqliteDb } = require('../db');

const storeName = process.argv[2];
const storeSlug = process.argv[3];

if (!storeName || !storeSlug) {
    console.log("Usage: node provision-store.js \"Store Name\" \"store-slug\"");
    process.exit(1);
}

const tenantId = crypto.randomUUID();
const apiKey = 'rxpos_' + crypto.randomBytes(24).toString('hex');

async function provision() {
    try {
        if (usePostgres) {
            await pool.query(
                "INSERT INTO stores (id, slug, api_key, store_name) VALUES ($1, $2, $3, $4)",
                [tenantId, storeSlug, apiKey, storeName]
            );
        } else {
            const stmt = sqliteDb.prepare("INSERT INTO stores (id, slug, api_key, store_name) VALUES (?, ?, ?, ?)");
            stmt.run(tenantId, storeSlug, apiKey, storeName);
        }
        console.log("\n==================================================");
        console.log("🎉 SUCCESS: NEW TENANT STORE PROVISIONED!");
        console.log("==================================================");
        console.log(`Store Name:       ${storeName}`);
        console.log(`Store Slug:       ${storeSlug}`);
        console.log(`Tenant UUID:      ${tenantId}`);
        console.log(`Secure API Key:   ${apiKey}`);
        console.log("==================================================");
        console.log("Provide these details to the store manager to configure their local POS.\n");
        process.exit(0);
    } catch (err) {
        console.error("Provisioning failed:", err.message);
        process.exit(1);
    }
}

provision();
