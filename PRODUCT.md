# Product

## Register

product

## Platform

web

## Users
- **Cashier**: Works at the checkout counter under high-stress, high-throughput conditions. Focuses on speed, barcode scanning, and keyboard shortcuts (F1-F5) to complete transactions without a mouse.
- **Pharmacist**: Evaluates prescriptions, manages inventory, oversees regulated/controlled substances, and overrides cashier warning gates.
- **Admin/Store Owner**: Tracks daily net margins, procurement queues, dead stock analytics, and manages system settings/network configuration.
- **Client Devices**: Other tablets, phones, or auxiliary terminals on the local WiFi network accessing the shared inventory/POS system.

## Product Purpose
Provide a zero-configuration, local-first Pharmacy POS and Inventory database. It compiles into a standalone desktop `.exe` installer for the main server PC while running an embedded Express API server that allows other devices on the local WiFi network to access and perform POS functions via standard web browsers.

## Brand Personality
- **Voice/Tone**: Secure, clinical, highly responsive, professional.
- **3-Word Personality**: Precise, Clinical, Kinetic.
- **Emotional Goals**: Instill confidence in accuracy, offer tactile feedback for rapid data entry, and clearly demarcate security states.

## Anti-references
- **The SaaS "Paper/Cream" Monoculture**: No beige backgrounds or default warm card layouts.
- **Legacy Dull Gray POS**: No blocky, retro, un-styled tables or default browser dropdowns.
- **Low-Contrast Grays**: No washed-out text or hard-to-read warnings.

## Design Principles
1. **Kinetic Keyboard-First UI**: The interface must be completely operable without a mouse. Transitions and focus states should direct the eyes instantly to relevant fields (e.g. active cell highlight, primary barcode focus).
2. **Clinical Contrast and Color Roles**: Colors are data. Neon cyan represents default user actions; emerald represents successful or active statuses; neon rose represents critical warnings, expiration alerts, and prescription gates.
3. **Glassmorphic Spatial Hierarchy**: Use dark overlay layers with backdrops and subtle borders to layer modals and override prompts clearly above the main transaction grid.
4. **Resilient Local-First Parity**: Offline actions must feel identical to connected client actions. The system is solid, instant, and never displays network-induced latency.

## Accessibility & Inclusion
- **Contrast**: Text and indicators must meet WCAG AA standards (≥ 4.5:1 ratio) on all screens.
- **Reduced Motion**: Respect media query preferences; replace sliding drawers and zoom-ins with quick crossfades.
- **Focus Outlines**: Highly visible custom ring outlines for keyboard-focused buttons and input elements.
