const { contextBridge } = require('electron');

// Expose safe environment indicators to the renderer script
contextBridge.exposeInMainWorld('electronAPI', {
    isDesktop: true
});
