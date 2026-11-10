const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const P = require('pino');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

// ==================== STATE ====================
let sock = null;
let isReady = false;
let isInitializing = false;
let qrCodeBase64 = null;
let qrCodeRaw = null;
let status = 'disconnected';

const SESSION_DIR = './baileys_auth';

// Logger: silent-ish so QR isn't drowned
const logger = P({ level: 'silent' });

// ==================== HELPERS ====================

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        console.log(`📁 Created auth directory: ${SESSION_DIR}`);
    }
}

async function destroyClient() {
    if (!sock) return;
    try {
        console.log('🧨 Closing socket...');
        sock.ev.removeAllListeners();
        sock.end(undefined);
    } catch (err) {
        console.error('Error closing socket:', err.message);
    } finally {
        sock = null;
        isReady = false;
    }
}

/**
 * Normalize any input (group id, lid, c.us) into a WhatsApp JID.
 */
function toJid(id) {
    if (!id) return null;
    if (id.includes('@')) return id;
    return `${id}@g.us`;
}

/**
 * Get all groups the bot participates in.
 * Baileys fetches them directly from the server — no browser hacks needed.
 */
async function safeGetGroups() {
    try {
        if (!sock) return [];
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups || {}).map((g) => ({
            id: g.id,
            name: g.subject || 'Unnamed Group',
            participants: g.participants?.length || 0,
            isGroup: true,
        }));
        console.log(`✅ groupFetchAllParticipating() returned ${list.length} groups`);
        return list;
    } catch (err) {
        console.error('❌ Failed to fetch groups:', err?.message || err);
        return [];
    }
}

function getStatusMessage(s) {
    const messages = {
        disconnected: 'Bot is disconnected',
        qr_generated: 'Scan QR code to connect',
        authenticated: 'Authenticated, connecting...',
        ready: 'Bot is ready!',
        error: 'Error occurred',
    };
    return messages[s] || s;
}

// ==================== BAILEYS CLIENT ====================

async function initializeClient() {
    if (isInitializing) {
        console.log('⏳ Already initializing, skipping...');
        return;
    }
    if (sock && isReady) {
        console.log('✅ Client already ready, skipping init.');
        return;
    }

    isInitializing = true;
    console.log('🚀 Initializing Baileys client...');

    try {
        ensureSessionDir();
        await destroyClient();

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📡 Using Baileys version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            browser: ['KIEMS Bot', 'Chrome', '1.0.0'],
        });

        // ---------- Creds persistence ----------
        sock.ev.on('creds.update', saveCreds);

        // ---------- Connection updates ----------
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR Code generated. Scan with WhatsApp:');
                qrcode.generate(qr, { small: true });
                qrCodeRaw = qr;
                status = 'qr_generated';
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, {
                        type: 'image/png',
                        margin: 2,
                        scale: 8,
                        errorCorrectionLevel: 'H',
                    });
                    console.log(`✅ QR Code saved as base64 (length: ${qrCodeBase64.length})`);
                } catch (err) {
                    console.error('Failed to generate QR image:', err.message);
                    try {
                        qrCodeBase64 = await QRCode.toDataURL(qr);
                    } catch (err2) {
                        console.error('Fallback also failed:', err2.message);
                    }
                }
            }

            if (connection === 'open') {
                console.log('🎉 Baileys client is ready!');
                isReady = true;
                isInitializing = false;
                status = 'ready';
                qrCodeBase64 = null;
                qrCodeRaw = null;
            }

            if (connection === 'close') {
                const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
                console.log(`⚠️ Connection closed. Code: ${code}`);

                isReady = false;
                isInitializing = false;

                if (code === DisconnectReason.loggedOut) {
                    console.log('🚪 Logged out. Delete ./baileys_auth and re-scan.');
                    status = 'disconnected';
                    await destroyClient();
                } else {
                    status = 'disconnected';
                    console.log('🔄 Reconnecting in 5 seconds...');
                    setTimeout(() => initializeClient(), 5000);
                }
            }
        });

        // ---------- Incoming messages ----------
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                try {
                    if (!msg.message || msg.key.fromMe) continue;

                    const from = msg.key.remoteJid;
                    const body =
                        msg.message.conversation ||
                        msg.message.extendedTextMessage?.text ||
                        msg.message.imageMessage?.caption ||
                        msg.message.videoMessage?.caption ||
                        '';

                    console.log(`📩 Message from ${from}: ${body}`);

                    if (body === '!ping') {
                        await sock.sendMessage(from, { text: '🏓 Pong! Bot is alive.' }, { quoted: msg });
                    }

                    if (body === '!status') {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `🤖 *Bot Status*\n\n` +
                                    `✅ Status: Online\n` +
                                    `📱 Connected: Yes\n` +
                                    `🕐 ${new Date().toLocaleString()}`,
                            },
                            { quoted: msg }
                        );
                    }

                    if (body === '!help') {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `📖 *Available Commands*\n\n` +
                                    `!ping - Check if bot is alive\n` +
                                    `!status - Show bot status\n` +
                                    `!help - Show this help\n` +
                                    `!about - About this bot\n` +
                                    `!groups - List available groups`,
                            },
                            { quoted: msg }
                        );
                    }

                    if (body === '!about') {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `🤖 *WhatsApp Bot*\n\n` +
                                    `Version: 1.0.0 (Baileys)\n` +
                                    `Type: Notification Bot\n` +
                                    `Status: 🟢 Online\n\n` +
                                    `📌 Built with Baileys`,
                            },
                            { quoted: msg }
                        );
                    }

                    if (body === '!groups') {
                        if (!isReady) {
                            await sock.sendMessage(from, { text: '❌ Bot is not ready yet.' });
                            continue;
                        }
                        const groups = await safeGetGroups();
                        let txt = '📋 *Available Groups*\n\n';
                        if (groups.length === 0) {
                            txt = 'No groups found. Make sure you are in at least one group.';
                        } else {
                            groups.forEach((g, i) => {
                                txt += `${i + 1}. ${g.name}\n`;
                                txt += `   ID: ${g.id}\n`;
                                txt += `   Members: ${g.participants}\n\n`;
                            });
                        }
                        await sock.sendMessage(from, { text: txt }, { quoted: msg });
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            }
        });

        isInitializing = false;
    } catch (err) {
        console.error('❌ Failed to initialize client:', err.message);
        status = 'error';
        isInitializing = false;
        isReady = false;
        await destroyClient();
    }
}

// ==================== EXPRESS ENDPOINTS ====================

app.get('/status', (req, res) => {
    res.json({
        status,
        isReady,
        hasQr: !!qrCodeBase64 || !!qrCodeRaw,
        qr: qrCodeBase64 || null,
        uptime: process.uptime(),
        message: getStatusMessage(status),
    });
});

app.get('/qr', async (req, res) => {
    try {
        if (qrCodeBase64 && qrCodeBase64.startsWith('data:image')) {
            return res.json({
                success: true,
                qr: qrCodeBase64,
                instructions: 'Scan this QR code with WhatsApp on your phone',
            });
        }
        if (qrCodeRaw) {
            qrCodeBase64 = await QRCode.toDataURL(qrCodeRaw, {
                type: 'image/png',
                margin: 2,
                scale: 8,
            });
            return res.json({
                success: true,
                qr: qrCodeBase64,
                instructions: 'Scan this QR code with WhatsApp on your phone',
            });
        }
        res.status(404).json({
            success: false,
            error: 'QR code not available. Check if bot is initialized.',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to generate QR code: ' + error.message,
        });
    }
});

app.get('/groups', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client is not ready. Please scan QR code first.',
                data: [],
            });
        }
        const groups = await safeGetGroups();
        res.json({ success: true, data: groups });
    } catch (error) {
        console.error('Groups endpoint error:', error);
        res.status(500).json({ success: false, error: error.message, data: [] });
    }
});

app.post('/send', async (req, res) => {
    try {
        const { groupId, message } = req.body;
        if (!groupId) return res.status(400).json({ success: false, error: 'Group ID is required' });
        if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
        if (!isReady) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });

        const jid = toJid(groupId);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.post('/send-dm', async (req, res) => {
    try {
        const { to, text } = req.body;
        if (!to) return res.status(400).json({ success: false, error: 'Recipient phone required' });
        if (!text) return res.status(400).json({ success: false, error: 'Text required' });
        if (!isReady) return res.status(503).json({ success: false, error: 'Bot not ready' });

        // Normalize phone to WhatsApp JID: "2547..." → "2547...@s.whatsapp.net"
        const jid = to.includes('@') ? to : `${to.replace(/\+/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/send-entry', async (req, res) => {
    try {
        const { groupId, entryData } = req.body;
        if (!groupId) return res.status(400).json({ success: false, error: 'Group ID is required' });
        if (!entryData) return res.status(400).json({ success: false, error: 'Entry data is required' });
        if (!isReady) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });

        const message = formatEntryMessage(entryData);
        await sock.sendMessage(toJid(groupId), { text: message });
        res.json({ success: true, message: 'Entry notification sent successfully' });
    } catch (error) {
        console.error('Send entry error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/send-summary', async (req, res) => {
    try {
        const { groupId, summaryData } = req.body;
        if (!groupId) return res.status(400).json({ success: false, error: 'Group ID is required' });
        if (!summaryData) return res.status(400).json({ success: false, error: 'Summary data is required' });
        if (!isReady) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });

        const message = formatSummaryMessage(summaryData);
        await sock.sendMessage(toJid(groupId), { text: message });
        res.json({ success: true, message: 'Summary sent successfully' });
    } catch (error) {
        console.error('Send summary error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/init', async (req, res) => {
    if (sock && isReady) {
        return res.json({ success: true, message: 'Bot is already initialized and ready' });
    }
    if (isInitializing) {
        return res.json({ success: true, message: 'Bot initialization already in progress.' });
    }
    initializeClient();
    res.json({ success: true, message: 'Bot initialization started. Check /status for progress.' });
});

app.post('/disconnect', async (req, res) => {
    try {
        await destroyClient();
        status = 'disconnected';
        qrCodeBase64 = null;
        qrCodeRaw = null;
        res.json({ success: true, message: 'Bot disconnected successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch (e) { /* ignore */ }
            await destroyClient();
        }
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log('🗑️ Auth folder deleted.');
        }
        status = 'disconnected';
        qrCodeBase64 = null;
        qrCodeRaw = null;
        res.json({ success: true, message: 'Logged out and auth cleared' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== MESSAGE FORMATTERS ====================

function formatEntryMessage(entry) {
    let message = `📋 *KIEMS Entry Update*\n\n`;
    message += `📅 *Date:* ${entry.entry_date || new Date().toISOString().split('T')[0]}\n`;
    message += `⏰ *Time:* ${entry.time || new Date().toLocaleTimeString()}\n\n`;
    message += `📦 *Kit:* ${entry.kit_name || 'N/A'}\n`;
    message += `📍 *Ward:* ${entry.ward_name || 'N/A'}\n`;
    message += `🏷️ *Phase:* ${entry.phase_name || 'N/A'}\n`;
    message += `👤 *VRA:* ${entry.vra_name || 'N/A'}\n`;
    message += `🏢 *Venue:* ${entry.venue || 'N/A'}\n\n`;
    message += `👥 *Registrations:*\n`;
    message += `├ ♂️ Male: ${entry.male || 0}\n`;
    message += `├ ♀️ Female: ${entry.female || 0}\n`;
    message += `└ 🧑 Other: ${entry.other || 0}\n\n`;
    message += `📊 *Total Registered:* ${entry.total_registered || 0}\n`;
    message += `🔄 *Transferred:* ${entry.transferred || 0}\n`;
    message += `📝 *Updated:* ${entry.updated || 0}\n\n`;
    message += `✅ *Status:* ${entry.uploaded ? 'Uploaded ✅' : 'Pending ⏳'}`;
    return message;
}

function formatSummaryMessage(summary) {
    const date = new Date().toLocaleDateString();
    let message = `📊 *KIEMS Daily Summary*\n`;
    message += `📅 ${date}\n\n`;
    message += `📈 *Today's Performance:*\n`;
    message += `├ 📝 Total Entries: ${summary.total_entries || 0}\n`;
    message += `├ 📦 Active Kits: ${summary.unique_kits || 0}\n`;
    message += `└ 👥 Total Registered: ${summary.total_registered || 0}\n\n`;
    message += `👤 *Gender Breakdown:*\n`;
    message += `├ ♂️ Male: ${summary.total_male || 0}\n`;
    message += `├ ♀️ Female: ${summary.total_female || 0}\n`;
    message += `└ 🧑 Other: ${summary.total_other || 0}\n\n`;
    message += `🔄 *Transfers:* ${summary.total_transferred || 0}\n`;
    message += `📝 *Updates:* ${summary.total_updated || 0}\n\n`;
    if (summary.top_kit) {
        message += `🏆 *Top Kit:* ${summary.top_kit} - ${summary.top_kit_count || 0} registrations\n\n`;
    }
    if (summary.wards && summary.wards.length > 0) {
        const topWards = summary.wards.slice(0, 5);
        message += `📊 *Ward Summary:*\n`;
        topWards.forEach((ward, index) => {
            const prefix = index < topWards.length - 1 ? '├' : '└';
            message += `${prefix} ${ward.name}: ${ward.count} registrations\n`;
        });
    }
    return message;
}

// ==================== START SERVER ====================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Baileys Bot Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/status`);
    console.log(`📌 Endpoints:`);
    console.log(`   GET  /status       - Check bot status`);
    console.log(`   GET  /qr           - Get QR code`);
    console.log(`   GET  /groups       - List WhatsApp groups`);
    console.log(`   POST /init         - Initialize bot`);
    console.log(`   POST /send         - Send message to group`);
    console.log(`   POST /send-entry   - Send entry notification`);
    console.log(`   POST /send-summary - Send daily summary`);
    console.log(`   POST /disconnect   - Close socket`);
    console.log(`   POST /logout       - Log out + wipe auth`);
    console.log('\n🤖 WhatsApp commands: !ping | !status | !help | !about | !groups');
    console.log('\n📱 Starting Baileys client...');

    initializeClient();
});

// ==================== GRACEFUL SHUTDOWN ====================

async function shutdown(signal) {
    console.log(`\n🛑 Received ${signal}. Shutting down...`);
    await destroyClient();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('💥 Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled rejection:', reason));