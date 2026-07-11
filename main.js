const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { startServer } = require('./server');

let mainWindow;

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "Pharmacy POS & Inventory Manager",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Purge any HTTP cache left by a previous install so an updated build never
    // renders stale renderer assets, then load the local Express web server URL.
    mainWindow.webContents.session.clearCache().finally(() => {
        mainWindow.loadURL('http://localhost:' + port);
    });

    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// 2. TRIGGER ZERO-CLICK BACKUPS ON CLOSE
function performDbBackup() {
    try {
        const { dbPath } = require('./db');
        if (!fs.existsSync(dbPath)) return;
        
        const dbDir = path.dirname(dbPath);
        const backupsDir = path.join(dbDir, 'backups');
        if (!fs.existsSync(backupsDir)) {
            fs.mkdirSync(backupsDir, { recursive: true });
        }
        
        // Generate YYYYMMDD_HHMMSS timestamp layout
        const date = new Date();
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        
        const timestamp = `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
        const backupName = `inventory_backup_${timestamp}.db`;
        const backupPath = path.join(backupsDir, backupName);
        
        // Copy SQLite database file safely
        fs.copyFileSync(dbPath, backupPath);
        console.log(`[Backup] Database backup created at: ${backupPath}`);
        
        // Retain only 10 most recent backups
        const backupFiles = fs.readdirSync(backupsDir)
            .filter(file => file.startsWith('inventory_backup_') && file.endsWith('.db'))
            .map(file => ({
                name: file,
                filePath: path.join(backupsDir, file),
                mtime: fs.statSync(path.join(backupsDir, file)).mtime.getTime()
            }))
            .sort((a, b) => a.mtime - b.mtime); // Oldest first

        if (backupFiles.length > 10) {
            const countToDelete = backupFiles.length - 10;
            console.log(`[Backup] Total backups count ${backupFiles.length}. Deleting oldest ${countToDelete} backups...`);
            for (let i = 0; i < countToDelete; i++) {
                fs.unlinkSync(backupFiles[i].filePath);
                console.log(`[Backup] Removed old backup file: ${backupFiles[i].name}`);
            }
        }
    } catch (err) {
        console.error(`[Backup] Zero-Click backup failed: ${err.message}`);
    }
}

let activePort = 8080;

app.on('ready', () => {
    startServer(8080)
        .then(({ server, port }) => {
            activePort = port;
            createWindow(port);
        })
        .catch(err => {
            console.error("Failed to start Express API server:", err);
            app.quit();
        });
});

app.on('window-all-closed', function () {
    // Perform backup before shutting down
    performDbBackup();
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow(activePort);
    }
});
