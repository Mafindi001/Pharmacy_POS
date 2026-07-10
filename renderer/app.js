// ==========================================
// rxmanager FRONTEND APPLICATION CONTROLLER (app.js)
// ==========================================

// Global Application State
let currentUser = null;
let cart = []; // Array of { product, quantity, sell_type } (sell_type: 'UNIT' | 'PACK')
let activeCartRowIndex = 0; // For F2 keyboard navigation
let productsRegistry = []; // Cached products for dropdown search
let serverIpInfo = null;


// Barcode scanner wedge listener state
lastKeyTime = 0;
let barcodeBuffer = '';
const SCANNER_CHAR_INTERVAL_MS = 30; // Threshold to distinguish scanner from human typing

document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setupEventListeners();
    setupKeyboardListeners();
});

// ==========================================
// 1. APPLICATION INITIALIZATION
// ==========================================
async function initApp() {
    console.log("[App] Initializing POS & Client workspace...");
    
    // Fetch Server Network IP details (LAN visibility)
    try {
        const res = await fetch('/api/network-ip');
        if (res.ok) {
            serverIpInfo = await res.json();
            document.getElementById('server-lan-ip').textContent = serverIpInfo.url;
            console.log(`[App] Server active at: ${serverIpInfo.url}`);
        }
    } catch (e) {
        console.warn("[App] Could not fetch server IP info, defaulting to local connection.");
    }
    
    // Check if user is already logged in (local state)
    const savedUser = sessionStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        loadUserSession();
    }
    
    // Check Activation Status on boot
    try {
        const actRes = await fetch('/api/activation-status');
        if (actRes.ok) {
            const actData = await actRes.json();
            const actScreen = document.getElementById('activation-screen');
            const loginScreen = document.getElementById('login-screen');
            
            if (actData.activated) {
                if (actScreen) actScreen.classList.remove('active');
                if (loginScreen) loginScreen.classList.add('active');
                
                // Load sync credentials configuration
                fetchSyncConfig();
                
                // Trigger initial pull/push sync sequence
                executeSyncProcess();
                
                // Schedule periodic background database sync worker (every 60 seconds)
                setInterval(executeSyncProcess, 60000);
            } else {
                if (actScreen) actScreen.classList.add('active');
                if (loginScreen) loginScreen.classList.remove('active');
            }
        }
    } catch (e) {
        console.error("Failed to check activation status:", e);
    }
}

function loadUserSession() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-container').classList.remove('hide');
    
    // Set Profile Info
    document.getElementById('user-display-name').textContent = currentUser.full_name;
    document.getElementById('user-display-role').textContent = currentUser.role;
    document.getElementById('user-role-avatar').textContent = currentUser.username.slice(0, 2).toUpperCase();
    
    // Show/hide navigation tabs based on roles
    updateNavigationForRole(currentUser.role);
    
    // Fetch products list for searches
    fetchProductsRegistry();
    
    // Reset Cart
    clearCart();
    
    // Go to default allowed view
    if (currentUser.role === 'ACCOUNTING') {
        switchTab('tab-reports');
    } else {
        switchTab('tab-pos');
    }
}

// ==========================================
// 2. CLIENT-SIDE ACTION LISTENERS
// ==========================================
function setupEventListeners() {
    // 1. Login Form Submit
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const usernameInput = document.getElementById('login-username').value;
        const passwordInput = document.getElementById('login-password').value;
        const errorDiv = document.getElementById('login-error');
        
        errorDiv.classList.add('hide');
        
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: usernameInput, password: passwordInput })
            });
            
            const data = await res.json();
            if (res.ok) {
                currentUser = data;
                sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
                loadUserSession();
            } else {
                errorDiv.textContent = data.error || "Authentication failed.";
                errorDiv.classList.remove('hide');
            }
        } catch (err) {
            errorDiv.textContent = "Server offline. Verify local execution.";
            errorDiv.classList.remove('hide');
        }
    });

    // 2. Logout Button
    document.getElementById('logout-btn').addEventListener('click', () => {
        sessionStorage.removeItem('currentUser');
        currentUser = null;
        document.getElementById('app-container').classList.add('hide');
        document.getElementById('login-screen').classList.add('active');
    });

    // 3. Main Navigation Links
    document.querySelectorAll('.nav-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabId = btn.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // 4. Inventory Subnav Links
    document.querySelectorAll('.subnav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const subtabId = btn.getAttribute('data-subtab');
            switchSubtab(subtabId, btn);
        });
    });

    // Product Add Modal Trigger
    const openAddProductModalBtn = document.getElementById('open-add-product-modal-btn');
    if (openAddProductModalBtn) {
        openAddProductModalBtn.addEventListener('click', () => {
            document.getElementById('product-modal-form').reset();
            document.getElementById('modal-custom-category-group').classList.add('hide');
            document.getElementById('product-modal').classList.add('active');
        });
    }

    // Product Add Modal Cancel
    const productModalCancel = document.getElementById('product-modal-cancel');
    if (productModalCancel) {
        productModalCancel.addEventListener('click', () => {
            document.getElementById('product-modal').classList.remove('active');
        });
    }

    // Modal Category change custom input toggle
    const modalProdCategory = document.getElementById('modal-prod-category');
    if (modalProdCategory) {
        modalProdCategory.addEventListener('change', (e) => {
            const val = e.target.value;
            const customGroup = document.getElementById('modal-custom-category-group');
            const customInput = document.getElementById('modal-prod-custom-category');
            if (customGroup && customInput) {
                if (val === 'Others') {
                    customGroup.classList.remove('hide');
                    customInput.required = true;
                    customInput.focus();
                } else {
                    customGroup.classList.add('hide');
                    customInput.required = false;
                    customInput.value = '';
                }
            }
        });
    }

    // Product Add Modal Form Submit (POST /api/products)
    const productModalForm = document.getElementById('product-modal-form');
    if (productModalForm) {
        productModalForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const categoryVal = document.getElementById('modal-prod-category').value;
            const finalCategory = categoryVal === 'Others'
                ? document.getElementById('modal-prod-custom-category').value.trim()
                : categoryVal;
                
            if (!finalCategory) {
                alert("Please enter a custom category name.");
                return;
            }
            
            const payload = {
                product_name: document.getElementById('modal-prod-name').value.trim(),
                generic_name: document.getElementById('modal-prod-generic').value.trim() || null,
                sku: '',
                barcode: '',
                category: finalCategory,
                form: document.getElementById('modal-prod-form').value,
                pack_size: 'Unit',
                base_unit_multiplier: 1,
                reorder_level: 10,
                is_prescription_required: document.getElementById('modal-prod-rx').checked ? 1 : 0,
                minimum_order_quantity: parseInt(document.getElementById('modal-prod-moq').value) || 1,
                quantity: parseInt(document.getElementById('modal-prod-qty').value) || 0,
                cost_price: parseFloat(document.getElementById('modal-prod-cost').value) || 0.0,
                selling_price: parseFloat(document.getElementById('modal-prod-price').value) || 0.0
            };
            
            try {
                const res = await fetch('/api/products', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    alert("Product registered successfully!");
                    document.getElementById('product-modal').classList.remove('active');
                    fetchProductsRegistry();
                } else {
                    const data = await res.json();
                    alert(`Error: ${data.error}`);
                }
            } catch (err) {
                alert(`Error: ${err.message}`);
            }
        });
    }

    // Sales Ledger Filter dropdown listener
    const ledgerFilter = document.getElementById('sales-ledger-filter');
    if (ledgerFilter) {
        ledgerFilter.addEventListener('change', fetchSalesLedger);
    }

    // Mobile Navigation Drawer Toggle and Backdrop listeners
    const mobileNavToggle = document.getElementById('mobile-nav-toggle');
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    
    if (mobileNavToggle && sidebar && sidebarOverlay) {
        mobileNavToggle.addEventListener('click', () => {
            sidebar.classList.add('open');
            sidebarOverlay.classList.remove('hide');
        });
        
        sidebarOverlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.add('hide');
        });
    }

    // POS Mobile checkout toggles
    const mobileCheckoutNextBtn = document.getElementById('mobile-checkout-next-btn');
    const mobileCheckoutBackBtn = document.getElementById('mobile-checkout-back-btn');
    const posWorkspace = document.querySelector('.pos-workspace');
    
    if (mobileCheckoutNextBtn && mobileCheckoutBackBtn && posWorkspace) {
        mobileCheckoutNextBtn.addEventListener('click', () => {
            posWorkspace.classList.add('show-checkout');
        });
        mobileCheckoutBackBtn.addEventListener('click', () => {
            posWorkspace.classList.remove('show-checkout');
        });
    }

    // Products mobile form/list toggle - Removed because layout is now full screen

    // Batches mobile form/list toggle
    const btnBatchForm = document.getElementById('btn-toggle-batch-form');
    const btnBatchList = document.getElementById('btn-toggle-batch-list');
    const batchGrid = document.querySelector('#subtab-batches .grid-2col');
    
    if (btnBatchForm && btnBatchList && batchGrid) {
        btnBatchForm.addEventListener('click', () => {
            batchGrid.classList.remove('show-list');
            btnBatchForm.classList.add('active');
            btnBatchList.classList.remove('active');
        });
        btnBatchList.addEventListener('click', () => {
            batchGrid.classList.add('show-list');
            btnBatchForm.classList.remove('active');
            btnBatchList.classList.add('active');
        });
    }

    // Staff mobile form/list toggle
    const btnStaffForm = document.getElementById('btn-toggle-staff-form');
    const btnStaffList = document.getElementById('btn-toggle-staff-list');
    const staffGrid = document.querySelector('#tab-staff .grid-2col');
    
    if (btnStaffForm && btnStaffList && staffGrid) {
        btnStaffForm.addEventListener('click', () => {
            staffGrid.classList.remove('show-list');
            btnStaffForm.classList.add('active');
            btnStaffList.classList.remove('active');
        });
        btnStaffList.addEventListener('click', () => {
            staffGrid.classList.add('show-list');
            btnStaffForm.classList.remove('active');
            btnStaffList.classList.add('active');
        });
    }

    // Staff Password Generator Button Listener
    const genPassBtn = document.getElementById('generate-staff-pass-btn');
    if (genPassBtn) {
        genPassBtn.addEventListener('click', () => {
            const generatedPass = generateRandomPassword(8);
            document.getElementById('staff-password').value = generatedPass;
        });
    }

    // Staff Registration Form Submit
    const staffForm = document.getElementById('staff-registration-form');
    if (staffForm) {
        staffForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                full_name: document.getElementById('staff-name').value,
                username: document.getElementById('staff-username').value,
                password: document.getElementById('staff-password').value,
                role: document.getElementById('staff-role').value
            };
            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    alert("Staff account created successfully!");
                    staffForm.reset();
                    fetchStaffRegistry();
                } else {
                    const data = await res.json();
                    alert(`Error: ${data.error}`);
                }
            } catch (err) {
                alert(`Error: ${err.message}`);
            }
        });
    }

    // User Profile Modal Open listener
    const userProfileEl = document.querySelector('.user-profile');
    if (userProfileEl) {
        userProfileEl.addEventListener('click', () => {
            if (!currentUser) return;
            document.getElementById('profile-full-name').value = currentUser.full_name;
            document.getElementById('profile-password').value = '';
            document.getElementById('profile-confirm-password').value = '';
            document.getElementById('profile-modal').classList.add('active');
        });
    }

    // User Profile Modal Cancel listener
    const profileCancelBtn = document.getElementById('profile-modal-cancel');
    if (profileCancelBtn) {
        profileCancelBtn.addEventListener('click', () => {
            document.getElementById('profile-modal').classList.remove('active');
        });
    }

    // User Profile Form Submit listener
    const profileForm = document.getElementById('profile-update-form');
    if (profileForm) {
        profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fullName = document.getElementById('profile-full-name').value.trim();
            const password = document.getElementById('profile-password').value;
            const confirmPassword = document.getElementById('profile-confirm-password').value;
            
            if (password !== confirmPassword) {
                alert("Passwords do not match.");
                return;
            }
            
            try {
                const res = await fetch(`/api/users/${currentUser.id}/profile`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ full_name: fullName, password: password })
                });
                
                if (res.ok) {
                    alert("Profile updated successfully!");
                    document.getElementById('profile-modal').classList.remove('active');
                    
                    // Update session storage
                    currentUser.full_name = fullName;
                    sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
                    
                    // Reload profile UI texts
                    document.getElementById('user-display-name').textContent = currentUser.full_name;
                    document.getElementById('user-role-avatar').textContent = currentUser.username.slice(0, 2).toUpperCase();
                } else {
                    const data = await res.json();
                    alert(`Error: ${data.error}`);
                }
            } catch (err) {
                alert(`Error: ${err.message}`);
            }
    }

    // Onboarding Activation Form Submit
    const activationForm = document.getElementById('activation-form');
    if (activationForm) {
        activationForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = document.getElementById('activation-submit-btn');
            const errorDiv = document.getElementById('activation-error');
            
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = "Verifying Credentials...";
            }
            if (errorDiv) {
                errorDiv.classList.add('hide');
                errorDiv.textContent = "";
            }
            
            const adminFullname = document.getElementById('activation-admin-fullname').value.trim();
            const adminUsername = document.getElementById('activation-admin-username').value.trim();
            const adminPassword = document.getElementById('activation-admin-password').value;
            
            if (adminPassword.length < 6) {
                if (errorDiv) {
                    errorDiv.textContent = "Administrator password must be at least 6 characters long.";
                    errorDiv.classList.remove('hide');
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Activate & Create Admin";
                }
                return;
            }
            
            const payload = {
                cloud_url: document.getElementById('activation-cloud-url').value.trim(),
                store_slug: document.getElementById('activation-store-slug').value.trim(),
                sync_api_key: document.getElementById('activation-api-key').value.trim(),
                admin_fullname: adminFullname,
                admin_username: adminUsername,
                admin_password: adminPassword
            };
            
            try {
                const res = await fetch('/api/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (res.ok) {
                    alert("Activation Successful! Your administrator account has been initialized.\n\nPlease log in using the credentials you just configured.");
                    
                    // Reload config parameters inside the settings forms
                    fetchSyncConfig();
                    
                    // Transition to login screen
                    document.getElementById('activation-screen').classList.remove('active');
                    document.getElementById('login-screen').classList.add('active');
                    
                    // Pre-fill configured admin username
                    const loginUsernameInput = document.getElementById('login-username');
                    if (loginUsernameInput) {
                        loginUsernameInput.value = adminUsername;
                        const loginPasswordInput = document.getElementById('login-password');
                        if (loginPasswordInput) loginPasswordInput.focus();
                    }
                    
                    // Start sync worker execution
                    executeSyncProcess();
                } else {
                    const data = await res.json();
                    if (errorDiv) {
                        errorDiv.textContent = data.error || "Activation failed.";
                        errorDiv.classList.remove('hide');
                    }
                }
            } catch (err) {
                if (errorDiv) {
                    errorDiv.textContent = `Network error: ${err.message}. Is your local server running?`;
                    errorDiv.classList.remove('hide');
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Activate & Create Admin";
                }
            }
        });
    }

    // Sync Configuration Form Submit
    const syncConfigForm = document.getElementById('sync-config-form');
    if (syncConfigForm) {
        syncConfigForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                cloud_url: document.getElementById('sync-cloud-url').value.trim(),
                store_slug: document.getElementById('sync-store-slug').value.trim(),
                sync_api_key: document.getElementById('sync-api-key').value.trim()
            };
            
            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    alert("Cloud Sync configuration saved successfully!");
                    // Trigger initial sync pull & push in background
                    executeSyncProcess(true);
                } else {
                    const data = await res.json();
                    alert(`Error: ${data.error}`);
                }
            } catch (err) {
                alert(`Error: ${err.message}`);
            }
        });
    }

    // Manual Sync Trigger Button
    const manualSyncBtn = document.getElementById('manual-sync-trigger-btn');
    if (manualSyncBtn) {
        manualSyncBtn.addEventListener('click', () => {
            executeSyncProcess(true);
        });
    }

    // 6. Batch Registration Form Submit
    document.getElementById('batch-registration-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const payload = {
            product_id: parseInt(document.getElementById('batch-product-select').value),
            batch_number: document.getElementById('batch-num').value,
            expiry_date: document.getElementById('batch-expiry').value,
            quantity_on_hand: parseInt(document.getElementById('batch-qty').value),
            cost_price: parseFloat(document.getElementById('batch-cost').value),
            selling_price: parseFloat(document.getElementById('batch-sell').value),
            supplier_name: document.getElementById('batch-supplier').value,
            user_id: currentUser ? currentUser.id : 1
        };

        try {
            const res = await fetch('/api/batches', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                alert("Batch stock received & logged in audit ledger!");
                document.getElementById('batch-registration-form').reset();
                fetchBatchesRegistry();
            } else {
                const data = await res.json();
                alert(`Error: ${data.error}`);
            }
        } catch (err) {
            alert(`Error: ${err.message}`);
        }
    });

    // 7. Dynamic Product Dropdown search selection in inventory restock
    document.getElementById('batch-product-select').addEventListener('focus', () => {
        populateProductDropdowns();
    });

    // 8. POS Product Search Dropdown key interactions
    const searchInput = document.getElementById('barcode-search');
    const searchDropdown = document.getElementById('search-results-dropdown');
    
    searchInput.addEventListener('input', (e) => {
        const query = searchInput.value.trim();
        if (query.length < 2) {
            searchDropdown.classList.add('hide');
            return;
        }
        
        const filtered = productsRegistry.filter(p => 
            p.product_name.toLowerCase().includes(query.toLowerCase()) ||
            (p.generic_name && p.generic_name.toLowerCase().includes(query.toLowerCase())) ||
            (p.sku && p.sku.toLowerCase().includes(query.toLowerCase())) ||
            (p.barcode && p.barcode.includes(query))
        );
        
        renderSearchResults(filtered);
    });

    // 9. Quantity modal handlers
    document.getElementById('modal-qty-cancel').addEventListener('click', () => {
        document.getElementById('qty-modal').classList.remove('active');
    });
    document.getElementById('modal-qty-confirm').addEventListener('click', confirmQtyAdjustment);

    // 10. Supervisor Override Form Handler
    document.getElementById('override-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('override-username').value;
        const password = document.getElementById('override-password').value;
        const errorDiv = document.getElementById('override-error');
        errorDiv.classList.add('hide');
        
        const pendingProduct = overrideFormPendingData;
        if (!pendingProduct) return;
        
        try {
            const res = await fetch('/api/auth/override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            
            if (res.ok) {
                // Authorized! Close modal and add product
                document.getElementById('override-modal').classList.remove('active');
                document.getElementById('override-form').reset();
                overrideFormPendingData = null;
                addItemToCartDirect(pendingProduct);
            } else {
                const data = await res.json();
                errorDiv.textContent = data.error || "Override Authorization Denied.";
                errorDiv.classList.remove('hide');
            }
        } catch (err) {
            errorDiv.textContent = "Override verification server offline.";
            errorDiv.classList.remove('hide');
        }
    });

    document.getElementById('override-cancel').addEventListener('click', () => {
        document.getElementById('override-modal').classList.remove('active');
        document.getElementById('override-form').reset();
        overrideFormPendingData = null;
    });

    // 11. Prescription Form Validation Listeners
    document.getElementById('doctor-name').addEventListener('input', validateCheckoutEnabling);
    document.getElementById('doctor-license').addEventListener('input', validateCheckoutEnabling);

    // 12. Checkout Submission Button
    document.getElementById('complete-checkout-btn').addEventListener('click', submitPOSInvoiceCheckout);

    // 13. Done/Close Receipt Modal
    document.getElementById('receipt-close-btn').addEventListener('click', () => {
        document.getElementById('receipt-modal').classList.remove('active');
        clearCart();
    });

    // 14. Sync reports button click
    document.getElementById('refresh-reports-btn').addEventListener('click', syncReportsAnalyticsData);
}

// ==========================================
// 3. KEYBOARD EVENT INTERCEPTION (F1-F5, ENTER, WEDGE SCANNER)
// ==========================================
function setupKeyboardListeners() {
    
    // Global Keyboard listener
    document.addEventListener('keydown', (e) => {
        
        // F1: Focus Barcode input
        if (e.key === 'F1') {
            e.preventDefault();
            const input = document.getElementById('barcode-search');
            input.focus();
            input.select();
        }
        
        // F2: Open Quantity Dialog for currently active/highlighted item
        if (e.key === 'F2') {
            e.preventDefault();
            if (cart.length > 0) {
                openQtyAdjustmentModal(activeCartRowIndex);
            }
        }
        
        // F5: Prompt Checkout
        if (e.key === 'F5') {
            e.preventDefault();
            const checkoutBtn = document.getElementById('complete-checkout-btn');
            if (!checkoutBtn.disabled) {
                checkoutBtn.focus();
            } else {
                alert("Checkout locked. Please verify doctor prescription inputs or supervisor overrides.");
            }
        }
        
        // ESC: Close Modals
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(modal => {
                if (modal.id !== 'login-screen') {
                    modal.classList.remove('active');
                }
            });
        }
    });

    // Barcode Scanner Wedges ("Keyboard wedges") trigger keypress events rapidly
    // We capture raw scanner values from the search input if they terminate in Enter
    const searchInput = document.getElementById('barcode-search');
    searchInput.addEventListener('keydown', (e) => {
        const currentTime = new Date().getTime();
        
        if (lastKeyTime !== 0 && (currentTime - lastKeyTime) < SCANNER_CHAR_INTERVAL_MS) {
            // Very rapid entry: assume barcode scanner input
            if (e.key === 'Enter') {
                e.preventDefault();
                const barcode = searchInput.value.trim();
                if (barcode.length > 0) {
                    console.log(`[Scanner] Rapid barcode string detected: ${barcode}`);
                    handleBarcodeScanned(barcode);
                }
            }
        }
        lastKeyTime = currentTime;
    });
}

// Handles lookup and direct cart addition when a barcode scanner successfully writes
async function handleBarcodeScanned(barcode) {
    const searchInput = document.getElementById('barcode-search');
    
    // Look up in products list
    const product = productsRegistry.find(p => p.barcode === barcode || p.sku === barcode);
    if (product) {
        addProductToCart(product);
        searchInput.value = '';
        document.getElementById('search-results-dropdown').classList.add('hide');
    } else {
        // Try fetching online or alert
        alert(`No registered product matches barcode: ${barcode}`);
        searchInput.select();
    }
}

// ==========================================
// 4. VIEW / TAB SYSTEM CONTROLLERS
// ==========================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-view').forEach(view => {
        view.classList.remove('active');
    });
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
    });

    const activeView = document.getElementById(tabId);
    if (activeView) {
        activeView.classList.add('active');
    }
    
    const activeLink = document.querySelector(`.nav-link[data-tab="${tabId}"]`);
    if (activeLink) {
        activeLink.classList.add('active');
    }

    // Auto-close mobile sidebar drawer
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        if (overlay) overlay.classList.add('hide');
    }

    // Trigger tab-specific loaders
    if (tabId === 'tab-inventory') {
        fetchProductsRegistry();
        fetchBatchesRegistry();
    } else if (tabId === 'tab-reports') {
        syncReportsAnalyticsData();
    } else if (tabId === 'tab-staff') {
        fetchStaffRegistry();
    } else if (tabId === 'tab-pos') {
        // Auto-focus search input
        setTimeout(() => {
            document.getElementById('barcode-search').focus();
        }, 100);
    }
}

function switchSubtab(subtabId, activeBtn) {
    document.querySelectorAll('.inventory-subtab-view').forEach(view => {
        view.classList.remove('active');
    });
    document.querySelectorAll('.subnav-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.getElementById(subtabId).classList.add('active');
    activeBtn.classList.add('active');
}

// ==========================================
// 5. DATABASE QUERIES & CACHING
// ==========================================
async function fetchProductsRegistry() {
    try {
        const res = await fetch('/api/products');
        if (res.ok) {
            productsRegistry = await res.json();
            renderProductsTable();
        }
    } catch (err) {
        console.error("Failed to load products registry", err);
    }
}

async function fetchBatchesRegistry() {
    try {
        const res = await fetch('/api/reports/near-expiry'); // Endpoint lists batches joined with products
        if (res.ok) {
            const data = await res.json();
            renderBatchesTable(data);
        }
    } catch (err) {
        console.error("Failed to load batches", err);
    }
}

function populateProductDropdowns() {
    const select = document.getElementById('batch-product-select');
    // Keep first option
    select.innerHTML = '<option value="">-- Choose registered product --</option>';
    
    productsRegistry.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.product_name} (${p.generic_name || 'No generic'}) - Mult: x${p.base_unit_multiplier}`;
        select.appendChild(opt);
    });
}

// ==========================================
// 6. POS WORKFLOW & CART CONTROLLER
// ==========================================
let overrideFormPendingData = null; // Stash item info while modal overrides authentication

function addProductToCart(product) {
    // Narcotics Category Supervisor Gate Check
    if (product.category === 'Narcotics' && currentUser && (currentUser.role === 'CASHIER' || currentUser.role === 'SALES')) {
        // Display Override Prompt
        overrideFormPendingData = product;
        document.getElementById('override-modal').classList.add('active');
        document.getElementById('override-password').focus();
        return;
    }
    
    addItemToCartDirect(product);
}

function addItemToCartDirect(product) {
    // Check if already in cart
    const existing = cart.find(item => item.product.id === product.id);
    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({
            product: product,
            quantity: 1,
            sell_type: 'UNIT' // Default to smallest unit sale
        });
    }
    
    activeCartRowIndex = cart.length - 1; // Highlight the latest added item
    renderCart();
}

function updateCartItemQty(index, newQty) {
    if (newQty <= 0) {
        cart.splice(index, 1);
        if (activeCartRowIndex >= cart.length) activeCartRowIndex = Math.max(0, cart.length - 1);
    } else {
        cart[index].quantity = parseInt(newQty);
    }
    renderCart();
}

function toggleSellType(index) {
    const item = cart[index];
    item.sell_type = item.sell_type === 'UNIT' ? 'PACK' : 'UNIT';
    renderCart();
}

function clearCart() {
    cart = [];
    activeCartRowIndex = 0;
    document.getElementById('doctor-name').value = '';
    document.getElementById('doctor-license').value = '';
    const posWorkspace = document.querySelector('.pos-workspace');
    if (posWorkspace) posWorkspace.classList.remove('show-checkout');
    renderCart();
}

let qtyAdjustmentTargetIndex = null;

function openQtyAdjustmentModal(index) {
    qtyAdjustmentTargetIndex = index;
    const item = cart[index];
    const qtyInput = document.getElementById('modal-qty-input');
    qtyInput.value = item.quantity;
    
    document.getElementById('qty-modal').classList.add('active');
    setTimeout(() => qtyInput.focus(), 100);
}

function confirmQtyAdjustment() {
    const qtyInput = document.getElementById('modal-qty-input');
    const newQty = parseInt(qtyInput.value) || 1;
    
    if (qtyAdjustmentTargetIndex !== null) {
        updateCartItemQty(qtyAdjustmentTargetIndex, newQty);
    }
    
    document.getElementById('qty-modal').classList.remove('active');
    qtyAdjustmentTargetIndex = null;
}

// Verify if prescription requirements are fulfilled
function validateCheckoutEnabling() {
    const requiresPrescription = cart.some(item => item.product.is_prescription_required === 1);
    const checkoutBtn = document.getElementById('complete-checkout-btn');
    
    if (cart.length === 0) {
        checkoutBtn.disabled = true;
        return;
    }
    
    if (requiresPrescription) {
        const docName = document.getElementById('doctor-name').value.trim();
        const docLicense = document.getElementById('doctor-license').value.trim();
        
        if (docName.length > 0 && docLicense.length > 0) {
            checkoutBtn.disabled = false;
        } else {
            checkoutBtn.disabled = true;
        }
    } else {
        checkoutBtn.disabled = false;
    }
}

// Complete checkout submission to Express API
async function submitPOSInvoiceCheckout() {
    const requiresPrescription = cart.some(item => item.product.is_prescription_required === 1);
    
    const payload = {
        user_id: currentUser ? currentUser.id : 1,
        customer_name: document.getElementById('cust-name').value || 'Walk-in Customer',
        customer_phone: document.getElementById('cust-phone').value || null,
        payment_method: document.querySelector('input[name="payment-type"]:checked').value,
        items: cart.map(item => ({
            product_id: item.product.id,
            quantity: item.quantity,
            sell_type: item.sell_type
        })),
        doctor_name: requiresPrescription ? document.getElementById('doctor-name').value : null,
        doctor_license_number: requiresPrescription ? document.getElementById('doctor-license').value : null
    };

    try {
        const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        
        if (res.ok) {
            // Render receipt modal
            document.getElementById('receipt-invoice-number').textContent = data.invoice_number;
            document.getElementById('receipt-cust-name').textContent = payload.customer_name;
            document.getElementById('receipt-pay-method').textContent = payload.payment_method;
            document.getElementById('receipt-total-amount').textContent = `₦${data.total_amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
            
            document.getElementById('receipt-modal').classList.add('active');
        } else {
            alert(`Checkout Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Checkout Server Error: ${err.message}`);
    }
}

// ==========================================
// 7. RENDERING ENGINE (DOM MUTATORS)
// ==========================================
function renderCart() {
    const tbody = document.getElementById('cart-tbody');
    tbody.innerHTML = '';
    
    if (cart.length === 0) {
        tbody.innerHTML = `
            <tr class="empty-state-row">
                <td colspan="8">
                    <div class="empty-table-state">
                        <span class="empty-icon">🛒</span>
                        <p>No products in the current transaction. Scan a barcode or press F1 to search.</p>
                    </div>
                </td>
            </tr>
        `;
        document.getElementById('summary-line-count').textContent = '0';
        document.getElementById('summary-total-qty').textContent = '0';
        document.getElementById('summary-total-amount').textContent = '₦0.00';
        document.getElementById('prescription-gate-panel').classList.add('hide');
        validateCheckoutEnabling();
        return;
    }
    
    let totalPieces = 0;
    let totalAmount = 0.0;
    let containsPrescription = false;
    
    cart.forEach((item, idx) => {
        const p = item.product;
        
        // Calculate items pieces
        const units = item.sell_type === 'UNIT' ? item.quantity : item.quantity * p.base_unit_multiplier;
        totalPieces += units;
        
        // Calculate item subtotal
        // Product batches contain unit cost. We assume the client sells units or boxes based on base multiplier.
        // Wait, where do we get product.price? We can fetch the price of the nearest expiring batch dynamically,
        // or query the database. In db.js, the allocateFEFOBatches queries batches to locate cost/price.
        // In the client, to show accurate prices, we can display the price from the product's cheapest/nearest batch.
        // Let's look up if the product has selling price cached or if we should fetch it.
        // During products query, let's make sure we also join the closest batch price, or default to a reasonable value.
        // To keep it robust, let's assume we query the database for product batch prices or keep a default unit price.
        // We will default to showing a unit price from available batches or ₦0.00 if none.
        const unitPrice = p.selling_price || 0.0; 
        const linePrice = item.sell_type === 'UNIT' ? unitPrice : unitPrice * p.base_unit_multiplier;
        const subtotal = linePrice * item.quantity;
        totalAmount += subtotal;
        
        if (p.is_prescription_required === 1) {
            containsPrescription = true;
        }
        
        const tr = document.createElement('tr');
        if (idx === activeCartRowIndex) {
            tr.classList.add('active-cart-row');
            tr.style.backgroundColor = 'var(--surface-hover)';
        }
        
        tr.innerHTML = `
            <td>
                <div style="display: flex; flex-direction: column;">
                    <strong style="color: var(--ink);">${p.product_name}</strong>
                    <span style="font-size: 0.72rem; color: var(--muted);">${p.sku || 'No SKU'}</span>
                </div>
            </td>
            <td><span style="font-size: 0.85rem;">${p.generic_name || '-'}</span></td>
            <td><span class="badge ${p.batch_expiry_alert ? 'warning-bg' : 'safe-bg'}">${p.batch_number || 'AUTO-FEFO'}</span></td>
            <td>
                <button class="sell-type-btn ${item.sell_type === 'UNIT' ? 'active' : ''}" onclick="toggleSellType(${idx})">Unit</button>
                <button class="sell-type-btn ${item.sell_type === 'PACK' ? 'active' : ''}" onclick="toggleSellType(${idx})">Pack</button>
            </td>
            <td>
                <div class="cart-qty-adjust">
                    <button class="qty-btn" onclick="updateCartItemQty(${idx}, ${item.quantity - 1})">-</button>
                    <span class="cart-qty-val">${item.quantity}</span>
                    <button class="qty-btn" onclick="updateCartItemQty(${idx}, ${item.quantity + 1})">+</button>
                </div>
            </td>
            <td>₦${linePrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
            <td><strong>₦${subtotal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
            <td>
                <button class="delete-row-btn" onclick="updateCartItemQty(${idx}, 0)">🗑️</button>
            </td>
        `;
        
        tr.addEventListener('click', () => {
            activeCartRowIndex = idx;
            renderCart();
        });
        
        tbody.appendChild(tr);
    });
    
    // Update summary labels
    document.getElementById('summary-line-count').textContent = cart.length;
    document.getElementById('summary-total-qty').textContent = totalPieces;
    const formattedTotal = `₦${totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('summary-total-amount').textContent = formattedTotal;
    
    const nextBtn = document.getElementById('mobile-checkout-next-btn');
    if (nextBtn) {
        nextBtn.textContent = `Proceed to Checkout (${formattedTotal})`;
    }
    
    // Toggle prescription gate panel visibility
    if (containsPrescription) {
        document.getElementById('prescription-gate-panel').classList.remove('hide');
    } else {
        document.getElementById('prescription-gate-panel').classList.add('hide');
    }
    
    validateCheckoutEnabling();
}

function renderSearchResults(results) {
    const dropdown = document.getElementById('search-results-dropdown');
    dropdown.innerHTML = '';
    
    if (results.length === 0) {
        dropdown.innerHTML = '<div style="padding: 12px; color: var(--muted); font-size: 0.85rem; text-align: center;">No matches found</div>';
        dropdown.classList.remove('hide');
        return;
    }
    
    results.slice(0, 8).forEach((p, idx) => {
        const div = document.createElement('div');
        div.className = 'search-item';
        
        // Show availability from database query or default
        const multiplierText = p.base_unit_multiplier > 1 ? ` (Pack size: ${p.pack_size || `x${p.base_unit_multiplier}`})` : '';
        const rxBadge = p.is_prescription_required === 1 ? ' <span class="badge danger-bg">Rx</span>' : '';
        const narcoticBadge = p.category === 'Narcotics' ? ' <span class="badge controlled-badge">Narcotic</span>' : '';
        
        div.innerHTML = `
            <div class="search-item-info">
                <span class="search-item-title">${p.product_name} ${rxBadge} ${narcoticBadge}</span>
                <span class="search-item-sub">${p.generic_name || ''} - SKU: ${p.sku || '-'} ${multiplierText}</span>
            </div>
            <div class="search-item-meta">
                <span class="search-item-qty">₦${(p.selling_price || 0.0).toFixed(2)} / unit</span>
            </div>
        `;
        
        div.addEventListener('click', () => {
            addProductToCart(p);
            document.getElementById('barcode-search').value = '';
            dropdown.classList.add('hide');
        });
        
        dropdown.appendChild(div);
    });
    
    dropdown.classList.remove('hide');
}

// Close search dropdown on click outside
document.addEventListener('click', (e) => {
    const searchWrapper = document.querySelector('.barcode-wrapper');
    if (searchWrapper && !searchWrapper.contains(e.target)) {
        document.getElementById('search-results-dropdown').classList.add('hide');
    }
});

function renderProductsTable() {
    const tbody = document.getElementById('registry-tbody');
    tbody.innerHTML = '';
    
    if (productsRegistry.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--muted); padding: 24px;">No products registered yet.</td></tr>';
        return;
    }
    
    productsRegistry.forEach(p => {
        const cost = p.cost_price || 0.0;
        const price = p.selling_price || 0.0;
        const profit = price - cost;
        const marginPercent = price > 0 ? ((profit / price) * 100).toFixed(1) : '0.0';
        
        // 1. Create main product row
        const tr = document.createElement('tr');
        tr.className = 'product-main-row';
        tr.title = "Click to expand/edit details";
        tr.addEventListener('click', () => toggleProductExpand(p.id));
        
        tr.innerHTML = `
            <td>
                <div style="display: flex; flex-direction: column;">
                    <strong style="color: var(--primary);">${p.product_name}</strong>
                    <span style="font-size: 0.72rem; color: var(--muted);">${p.generic_name || 'No chemical ingredient'}</span>
                </div>
            </td>
            <td>${p.category}</td>
            <td>₦${cost.toFixed(2)}</td>
            <td>₦${price.toFixed(2)}</td>
            <td>
                <span style="color: ${profit >= 0 ? 'var(--safe)' : 'var(--danger)'}; font-weight: 600;">
                    ₦${profit.toFixed(2)} (${marginPercent}%)
                </span>
            </td>
            <td>${p.minimum_order_quantity || 1}</td>
            <td><strong style="color: var(--ink);">${p.total_qty || 0} units</strong></td>
            <td>${p.is_prescription_required === 1 ? '<span class="badge danger-bg">Yes</span>' : '<span class="badge safe-bg">No</span>'}</td>
            <td>
                <div style="display: flex; gap: 6px; justify-content: center;">
                    <button class="btn secondary-btn" style="padding: 4px 8px; font-size: 0.78rem;">Edit</button>
                    <button class="btn danger-btn" style="padding: 4px 8px; font-size: 0.78rem; background-color: var(--danger); color: var(--bg); border: 0;" onclick="event.stopPropagation(); deleteProduct(${p.id}, '${p.product_name.replace(/'/g, "\\'")}')">Delete</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);

        // 2. Create detail expandable row
        const detailTr = document.createElement('tr');
        detailTr.id = `product-detail-${p.id}`;
        detailTr.className = 'product-detail-row hide';
        
        const defaults = ["Analgesics", "Antibiotics", "Antihistamines", "Antivirals", "Cardiovascular", "Narcotics", "OTC", "Syrups", "Antidiabetics", "Antifungals", "Vitamins & Supplements", "Vaccines"];
        const isCustomCategory = !defaults.includes(p.category);
        const categoryVal = isCustomCategory ? "Others" : p.category;
        
        detailTr.innerHTML = `
            <td colspan="9">
                <div class="expanded-detail-box" onclick="event.stopPropagation();">
                    <form onsubmit="saveProductInline(event, ${p.id})">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                            <h4 style="margin: 0; color: var(--primary); font-size: 1rem;">Edit Product: ${p.product_name}</h4>
                            <span style="font-size: 0.75rem; color: var(--muted);">ID: ${p.id} | Stock: ${p.total_qty || 0} units</span>
                        </div>
                        
                        <div class="input-group-row">
                            <div class="input-group">
                                <label>Product Name *</label>
                                <input type="text" id="inline-prod-name-${p.id}" value="${p.product_name.replace(/"/g, '&quot;')}" required>
                            </div>
                            <div class="input-group">
                                <label>Generic Name (Active Ingredient)</label>
                                <input type="text" id="inline-prod-generic-${p.id}" value="${(p.generic_name || '').replace(/"/g, '&quot;')}">
                            </div>
                        </div>
                        
                        <div class="input-group-row">
                            <div class="input-group">
                                <label>Category *</label>
                                <select id="inline-prod-category-${p.id}" onchange="toggleInlineCategory(${p.id})" required>
                                    <option value="Analgesics" ${categoryVal === 'Analgesics' ? 'selected' : ''}>Analgesics</option>
                                    <option value="Antibiotics" ${categoryVal === 'Antibiotics' ? 'selected' : ''}>Antibiotics</option>
                                    <option value="Antihistamines" ${categoryVal === 'Antihistamines' ? 'selected' : ''}>Antihistamines</option>
                                    <option value="Antivirals" ${categoryVal === 'Antivirals' ? 'selected' : ''}>Antivirals</option>
                                    <option value="Cardiovascular" ${categoryVal === 'Cardiovascular' ? 'selected' : ''}>Cardiovascular</option>
                                    <option value="Narcotics" ${categoryVal === 'Narcotics' ? 'selected' : ''}>Narcotics (Regulated)</option>
                                    <option value="OTC" ${categoryVal === 'OTC' ? 'selected' : ''}>OTC (Over the counter)</option>
                                    <option value="Syrups" ${categoryVal === 'Syrups' ? 'selected' : ''}>Syrups</option>
                                    <option value="Antidiabetics" ${categoryVal === 'Antidiabetics' ? 'selected' : ''}>Antidiabetics</option>
                                    <option value="Antifungals" ${categoryVal === 'Antifungals' ? 'selected' : ''}>Antifungals</option>
                                    <option value="Vitamins & Supplements" ${categoryVal === 'Vitamins & Supplements' ? 'selected' : ''}>Vitamins & Supplements</option>
                                    <option value="Vaccines" ${categoryVal === 'Vaccines' ? 'selected' : ''}>Vaccines</option>
                                    <option value="Others" ${categoryVal === 'Others' ? 'selected' : ''}>Others (Enter name below)</option>
                                </select>
                            </div>
                            <div class="input-group">
                                <label>Form *</label>
                                <select id="inline-prod-form-${p.id}" required>
                                    <option value="Tablet" ${p.form === 'Tablet' ? 'selected' : ''}>Tablet</option>
                                    <option value="Capsule" ${p.form === 'Capsule' ? 'selected' : ''}>Capsule</option>
                                    <option value="Syrup" ${p.form === 'Syrup' ? 'selected' : ''}>Syrup</option>
                                    <option value="Injection" ${p.form === 'Injection' ? 'selected' : ''}>Injection</option>
                                    <option value="Cream" ${p.form === 'Cream' ? 'selected' : ''}>Cream</option>
                                </select>
                            </div>
                        </div>

                        <!-- Inline Custom Category Field -->
                        <div class="input-group ${isCustomCategory ? '' : 'hide'}" id="inline-custom-category-group-${p.id}">
                            <label>Enter Custom Category Name *</label>
                            <input type="text" id="inline-prod-custom-category-${p.id}" value="${isCustomCategory ? p.category.replace(/"/g, '&quot;') : ''}" placeholder="e.g. Immunologicals">
                        </div>

                        <div class="input-group-row" style="grid-template-columns: repeat(3, 1fr);">
                            <div class="input-group">
                                <label>Minimum Order Qty *</label>
                                <input type="number" id="inline-prod-moq-${p.id}" value="${p.minimum_order_quantity || 1}" min="1" required>
                            </div>
                            <div class="input-group">
                                <label>Cost Price (₦ purchased) *</label>
                                <input type="number" id="inline-prod-cost-${p.id}" value="${cost.toFixed(2)}" min="0" step="0.01" required>
                            </div>
                            <div class="input-group">
                                <label>Selling Price (₦ sold) *</label>
                                <input type="number" id="inline-prod-price-${p.id}" value="${price.toFixed(2)}" min="0" step="0.01" required>
                            </div>
                        </div>

                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; flex-wrap: wrap; gap: 12px;">
                            <div class="input-group checkbox-group" style="margin-bottom: 0;">
                                <label class="checkbox-label">
                                    <input type="checkbox" id="inline-prod-rx-${p.id}" value="1" ${p.is_prescription_required === 1 ? 'checked' : ''}>
                                    <span>Requires Prescription</span>
                                </label>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button type="button" class="btn secondary-btn" style="padding: 6px 12px; font-size: 0.8rem;" onclick="toggleProductExpand(${p.id})">Cancel</button>
                                <button type="button" class="btn danger-btn" style="padding: 6px 12px; font-size: 0.8rem; background-color: var(--danger); color: var(--bg); border: 0;" onclick="deleteProduct(${p.id}, '${p.product_name.replace(/'/g, "\\'")}')">Delete Drug</button>
                                <button type="submit" class="btn primary-btn" style="padding: 6px 12px; font-size: 0.8rem;">Save Changes</button>
                            </div>
                        </div>
                    </form>
                </div>
            </td>
        `;
        tbody.appendChild(detailTr);
    });
}

function renderBatchesTable(batches) {
    const tbody = document.getElementById('batches-tbody');
    tbody.innerHTML = '';
    
    if (batches.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No inventory batches logged.</td></tr>';
        return;
    }
    
    batches.forEach(b => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${b.product_name}</strong></td>
            <td><span class="badge warning-bg">${b.batch_number}</span></td>
            <td>${b.expiry_date}</td>
            <td><strong style="color: var(--primary);">${b.quantity_on_hand} units</strong></td>
            <td>₦${b.cost_price.toFixed(2)}</td>
            <td>₦${b.selling_price.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ==========================================
// 8. BUSINESS REPORTS ANALYTICS RETRIEVER
// ==========================================
async function syncReportsAnalyticsData() {
    console.log("[Analytics] Refreshing business metrics reports...");
    
    try {
        // 1. Near Expiry
        const resExpiry = await fetch('/api/reports/near-expiry');
        if (resExpiry.ok) {
            const data = await resExpiry.json();
            document.getElementById('near-expiry-badge').textContent = data.length;
            const tbody = document.getElementById('report-expiry-tbody');
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--muted);">No near-expiry batches detected.</td></tr>';
            } else {
                data.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${item.product_name}</strong></td>
                        <td><span class="badge warning-bg">${item.batch_number}</span></td>
                        <td><span style="color: var(--danger); font-weight: 600;">${item.expiry_date}</span></td>
                        <td>${item.quantity_on_hand}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
        
        // 2. Low Stock
        const resLow = await fetch('/api/reports/low-stock');
        if (resLow.ok) {
            const data = await resLow.json();
            document.getElementById('low-stock-badge').textContent = data.length;
            const tbody = document.getElementById('report-lowstock-tbody');
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--muted);">All inventory levels active.</td></tr>';
            } else {
                data.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${item.product_name}</strong></td>
                        <td><span style="font-family: var(--font-mono); font-size: 0.8rem;">${item.sku || '-'}</span></td>
                        <td>${item.reorder_level}</td>
                        <td><span style="color: var(--danger); font-weight: 700;">${item.total_quantity_on_hand}</span></td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
        
        // 3. Dead Stock
        const resDead = await fetch('/api/reports/dead-stock');
        if (resDead.ok) {
            const data = await resDead.json();
            const tbody = document.getElementById('report-deadstock-tbody');
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--muted);">No dead stock found.</td></tr>';
            } else {
                data.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${item.product_name}</strong></td>
                        <td>${item.generic_name || '-'}</td>
                        <td><span style="font-family: var(--font-mono); font-size: 0.8rem;">${item.sku || '-'}</span></td>
                        <td>${item.category}</td>
                        <td>${item.total_quantity_on_hand} units</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
        
        // 4. Daily Margins Report
        const resMargins = await fetch('/api/reports/daily-margins');
        if (resMargins.ok) {
            const data = await resMargins.json();
            const tbody = document.getElementById('report-margins-tbody');
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No transaction logs recorded.</td></tr>';
            } else {
                data.forEach(row => {
                    const marginPercent = row.total_revenue > 0 ? ((row.net_profit / row.total_revenue) * 100).toFixed(1) : '0.0';
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${row.sales_date}</strong></td>
                        <td>${row.invoice_count}</td>
                        <td>₦${row.total_revenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td>₦${row.total_cogs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td><strong style="color: var(--safe);">₦${row.net_profit.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
                        <td><span class="badge safe-bg">${marginPercent}%</span></td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
        // 5. Sync Sales Ledger
        await fetchSalesLedger();
    } catch (err) {
        console.error("Failed to load business analytics sync data", err);
    }
}

// Product editing state triggers - Removed obsolete forms handlers (now handled inline)

// Sales ledger reports loader
async function fetchSalesLedger() {
    const filterSelect = document.getElementById('sales-ledger-filter');
    const filter = filterSelect ? filterSelect.value : 'today';
    const tbody = document.getElementById('report-sales-ledger-tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--muted);">Syncing transaction registry...</td></tr>';
    
    try {
        const res = await fetch(`/api/reports/sales-ledger?filter=${filter}`);
        if (res.ok) {
            const data = await res.json();
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--muted);">No matching transaction records found.</td></tr>';
                return;
            }
            
            data.forEach(inv => {
                const tr = document.createElement('tr');
                const dateObj = new Date(inv.created_at);
                const localTime = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                tr.innerHTML = `
                    <td><strong style="color: var(--primary); font-family: var(--font-mono);">${inv.invoice_number}</strong></td>
                    <td>${localTime}</td>
                    <td>${inv.customer_name}</td>
                    <td>${inv.cashier_name}</td>
                    <td><span class="badge safe-bg">${inv.payment_method}</span></td>
                    <td style="max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${inv.items_summary || ''}">${inv.items_summary || '-'}</td>
                    <td><strong>₦${inv.total_amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (err) {
        console.error("Failed to load sales ledger reports", err);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--danger);">Error syncing transaction history.</td></tr>';
    }
}

// Role based view management
function updateNavigationForRole(role) {
    const navStaff = document.getElementById('nav-staff');
    const navInventory = document.querySelector('[data-tab="tab-inventory"]');
    const navReports = document.querySelector('[data-tab="tab-reports"]');
    
    if (role === 'ADMIN') {
        if (navStaff) navStaff.classList.remove('hide');
        if (navInventory) navInventory.classList.remove('hide');
        if (navReports) navReports.classList.remove('hide');
    } else if (role === 'PHARMACIST') {
        if (navStaff) navStaff.classList.add('hide');
        if (navInventory) navInventory.classList.remove('hide');
        if (navReports) navReports.classList.remove('hide');
    } else if (role === 'ACCOUNTING') {
        if (navStaff) navStaff.classList.add('hide');
        if (navInventory) navInventory.classList.add('hide');
        if (navReports) navReports.classList.remove('hide');
    } else { // SALES or CASHIER
        if (navStaff) navStaff.classList.add('hide');
        if (navInventory) navInventory.classList.add('hide');
        if (navReports) navReports.classList.add('hide');
    }
}

// Fetch staff accounts
async function fetchStaffRegistry() {
    if (!currentUser || currentUser.role !== 'ADMIN') return;
    try {
        const res = await fetch('/api/users');
        if (res.ok) {
            const data = await res.json();
            renderStaffTable(data);
        }
    } catch (err) {
        console.error("Failed to fetch staff list", err);
    }
}

// Render staff accounts table
function renderStaffTable(staffList) {
    const tbody = document.getElementById('staff-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    staffList.forEach(u => {
        const tr = document.createElement('tr');
        const disableBtnText = u.is_active === 1 ? 'Disable' : 'Enable';
        const disableBtnClass = u.is_active === 1 ? 'danger-btn' : 'success-btn';
        const isSelf = currentUser && currentUser.id === u.id;
        
        tr.innerHTML = `
            <td><strong>${u.full_name}</strong></td>
            <td><span style="font-family: var(--font-mono);">${u.username}</span></td>
            <td><span class="badge warning-bg">${u.role}</span></td>
            <td>${u.is_active === 1 ? '<span class="badge safe-bg">Active</span>' : '<span class="badge danger-bg">Disabled</span>'}</td>
            <td>
                <div style="display: flex; gap: 8px;">
                    <button class="btn ${disableBtnClass}" style="padding: 4px 8px; font-size: 0.8rem;" ${isSelf ? 'disabled' : ''} onclick="toggleUserStatus(${u.id}, ${u.is_active === 1 ? 0 : 1})">
                        ${disableBtnText}
                    </button>
                    <button class="btn secondary-btn" style="padding: 4px 8px; font-size: 0.8rem;" onclick="resetUserPassword(${u.id}, '${u.username}')">
                        Reset Pass
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Toggle user active status
async function toggleUserStatus(id, newStatus) {
    try {
        const res = await fetch(`/api/users/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: newStatus })
        });
        if (res.ok) {
            fetchStaffRegistry();
        } else {
            const data = await res.json();
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// Generate random password helper
function generateRandomPassword(length = 8) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$";
    let pass = "";
    for (let i = 0; i < length; i++) {
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pass;
}

// Reset user password API call
async function resetUserPassword(id, username) {
    const defaultNewPass = generateRandomPassword(8);
    const newPass = prompt(`Enter new password for ${username} (or use generated one below):`, defaultNewPass);
    if (newPass === null) return; // user cancelled prompt
    
    if (newPass.trim().length < 6) {
        alert("Password must be at least 6 characters long.");
        return;
    }
    
    try {
        const res = await fetch(`/api/users/${id}/reset-password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPass })
        });
        if (res.ok) {
            alert(`Password for ${username} reset successfully to: ${newPass}`);
        } else {
            const data = await res.json();
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// Delete product entry API call
async function deleteProduct(id, productName) {
    if (!confirm(`Are you sure you want to delete ${productName} from the products registry?`)) {
        return;
    }
    
    try {
        const res = await fetch(`/api/products/${id}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            alert(`${productName} deleted successfully!`);
            fetchProductsRegistry();
        } else {
            const data = await res.json();
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// Toggle inline expand drug detail row
function toggleProductExpand(id) {
    const detailRow = document.getElementById(`product-detail-${id}`);
    if (detailRow) {
        // Close all other expanded rows first for a clean accordion effect
        document.querySelectorAll('.product-detail-row').forEach(row => {
            if (row.id !== `product-detail-${id}`) {
                row.classList.add('hide');
            }
        });
        detailRow.classList.toggle('hide');
    }
}

// Inline category dropdown custom category input toggle helper
function toggleInlineCategory(id) {
    const categorySelect = document.getElementById(`inline-prod-category-${id}`);
    const customGroup = document.getElementById(`inline-custom-category-group-${id}`);
    const customInput = document.getElementById(`inline-prod-custom-category-${id}`);
    if (categorySelect && customGroup && customInput) {
        if (categorySelect.value === 'Others') {
            customGroup.classList.remove('hide');
            customInput.required = true;
            customInput.focus();
        } else {
            customGroup.classList.add('hide');
            customInput.required = false;
            customInput.value = '';
        }
    }
}

// Save inline product edit form API submit call
async function saveProductInline(event, id) {
    event.preventDefault();
    
    const name = document.getElementById(`inline-prod-name-${id}`).value.trim();
    const generic = document.getElementById(`inline-prod-generic-${id}`).value.trim();
    const categorySelect = document.getElementById(`inline-prod-category-${id}`).value;
    const customInput = document.getElementById(`inline-prod-custom-category-${id}`);
    const customCategory = customInput ? customInput.value.trim() : "";
    const category = categorySelect === "Others" ? customCategory : categorySelect;
    const form = document.getElementById(`inline-prod-form-${id}`).value;
    const moq = parseInt(document.getElementById(`inline-prod-moq-${id}`).value) || 1;
    const cost = parseFloat(document.getElementById(`inline-prod-cost-${id}`).value) || 0.0;
    const price = parseFloat(document.getElementById(`inline-prod-price-${id}`).value) || 0.0;
    const rx = document.getElementById(`inline-prod-rx-${id}`).checked ? 1 : 0;
    
    if (categorySelect === "Others" && !category) {
        alert("Please enter a custom category name.");
        return;
    }
    
    const payload = {
        product_name: name,
        generic_name: generic || null,
        sku: '',
        barcode: '',
        category: category,
        form: form,
        pack_size: 'Unit',
        base_unit_multiplier: 1,
        reorder_level: 10,
        is_prescription_required: rx,
        minimum_order_quantity: moq,
        cost_price: cost,
        selling_price: price
    };
    
    try {
        const res = await fetch(`/api/products/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            alert("Drug registry details updated successfully!");
            fetchProductsRegistry();
        } else {
            const data = await res.json();
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// Fetch local sync configuration and update inputs
async function fetchSyncConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const config = await res.json();
            const cloudUrlEl = document.getElementById('sync-cloud-url');
            const storeSlugEl = document.getElementById('sync-store-slug');
            const apiKeyEl = document.getElementById('sync-api-key');
            
            if (cloudUrlEl) cloudUrlEl.value = config.cloud_url || '';
            if (storeSlugEl) storeSlugEl.value = config.store_slug || '';
            if (apiKeyEl) apiKeyEl.value = config.sync_api_key || '';
        }
    } catch (err) {
        console.error("Failed to load sync configurations", err);
    }
}

// Background sync worker execution cycle
async function executeSyncProcess(isManual = false) {
    const statusMsg = document.getElementById('sync-status-msg');
    
    if (isManual && statusMsg) {
        statusMsg.textContent = "Syncing with cloud central database...";
        statusMsg.style.color = "var(--primary)";
        statusMsg.classList.remove('hide');
    }
    
    try {
        // 1. Fetch current sync config parameters
        const configRes = await fetch('/api/config');
        if (!configRes.ok) throw new Error("Failed to read local sync config.");
        const config = await configRes.json();
        
        const { store_slug, sync_api_key, cloud_url, last_sync_timestamp } = config;
        
        if (!store_slug || !sync_api_key || !cloud_url) {
            if (isManual && statusMsg) {
                statusMsg.textContent = "Error: Sync config parameters are incomplete.";
                statusMsg.style.color = "var(--danger)";
            }
            return;
        }
        
        // 2. Push Cycle: Upload local pending invoices checkouts
        const queueRes = await fetch('/api/sync/queue');
        if (queueRes.ok) {
            const pendingEvents = await queueRes.json();
            if (pendingEvents.length > 0) {
                console.log(`[Sync Worker] Found ${pendingEvents.length} pending events to push...`);
                
                // Submit to Cloud server push route
                const pushRes = await fetch(`${cloud_url}/api/sync/push`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Store-API-Key': sync_api_key,
                        'X-Store-Slug': store_slug
                    },
                    body: JSON.stringify({ events: pendingEvents })
                });
                
                if (pushRes.ok) {
                    const ackData = await pushRes.json();
                    if (ackData.success && ackData.synced_ids) {
                        // Mark local sync queue records as synced
                        await fetch('/api/sync/queue/ack', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ids: ackData.synced_ids })
                        });
                        console.log(`[Sync Worker] Successfully pushed and acked events:`, ackData.synced_ids);
                    }
                } else {
                    const errData = await pushRes.json();
                    console.error("[Sync Worker] Cloud push rejected:", errData.error);
                    // Mark items as failed
                    for (const ev of pendingEvents) {
                        await fetch('/api/sync/queue/fail', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: ev.id, error: errData.error || 'Server rejected push' })
                        });
                    }
                }
            }
        }
        
        // 3. Pull Cycle: Download drug changes from the cloud dashboard
        console.log(`[Sync Worker] Pulling updates since: ${last_sync_timestamp}...`);
        const pullRes = await fetch(`${cloud_url}/api/sync/pull?since=${encodeURIComponent(last_sync_timestamp)}`, {
            method: 'GET',
            headers: {
                'X-Store-API-Key': sync_api_key,
                'X-Store-Slug': store_slug
            }
        });
        
        if (pullRes.ok) {
            const pullData = await pullRes.json();
            
            // If cloud has updates, apply them locally
            if (pullData.has_updates) {
                console.log(`[Sync Worker] Ingesting cloud updates locally...`, pullData);
                const applyRes = await fetch('/api/sync/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        products: pullData.products,
                        product_batches: pullData.product_batches,
                        users: pullData.users,
                        last_sync_timestamp: pullData.server_timestamp
                    })
                });
                
                if (applyRes.ok) {
                    console.log(`[Sync Worker] Cloud updates applied successfully.`);
                    // Refresh active UI databases
                    fetchProductsRegistry();
                    fetchBatchesRegistry();
                    fetchStaffRegistry();
                    syncReportsAnalyticsData();
                }
            } else {
                console.log(`[Sync Worker] Local database is fully up to date.`);
            }
        } else {
            console.error("[Sync Worker] Pull request failed:", pullRes.statusText);
        }
        
        if (isManual && statusMsg) {
            statusMsg.textContent = "Sync successful! Databases updated.";
            statusMsg.style.color = "var(--safe)";
            setTimeout(() => { statusMsg.classList.add('hide'); }, 4000);
        }
    } catch (err) {
        console.error("[Sync Worker] Execution cycle failed:", err.message);
        if (isManual && statusMsg) {
            statusMsg.textContent = `Sync Failed: ${err.message}. Central server offline?`;
            statusMsg.style.color = "var(--danger)";
        }
    }
}
