const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cấu hình bảo mật
const ADMIN_PASSWORD = "admin"; // Anh có thể đổi pass tại đây
let sessions = new Set();

// Database đơn giản bằng file
const dataDir = path.join(__dirname, 'data');
const configPath = path.join(dataDir, 'config.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function createDefaultProfile(id) {
    return {
        id: id,
        name: `Profile ${id}`,
        items: [],
        selectedZones: [],
        interval: 60000,
        cookie: "",
        discordEnabled: false,
        webhook: "",
        roleId: ""
    }
}

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) {
            const defaultConfig = {
                password: ADMIN_PASSWORD,
                profiles: [1, 2, 3, 4, 5].map(id => createDefaultProfile(id))
            };
            saveConfig(defaultConfig);
            return defaultConfig;
        }
        const data = JSON.parse(fs.readFileSync(configPath));
        // Migration for old config
        if (!data.profiles) {
            const migrated = {
                password: data.password || ADMIN_PASSWORD,
                profiles: [
                    {
                        id: 1,
                        name: "Profile 1",
                        items: data.items || [],
                        selectedZones: data.selectedZones || [],
                        interval: data.interval || 60000,
                        cookie: data.cookie || "",
                        discordEnabled: data.discordEnabled || false,
                        webhook: data.webhook || "",
                        roleId: data.roleId || ""
                    },
                    createDefaultProfile(2),
                    createDefaultProfile(3),
                    createDefaultProfile(4),
                    createDefaultProfile(5)
                ]
            };
            saveConfig(migrated);
            return migrated;
        }
        return data;
    } catch (err) {
        console.error("Lỗi đọc file cấu hình:", err);
        return {
            password: ADMIN_PASSWORD,
            profiles: [1, 2, 3, 4, 5].map(id => createDefaultProfile(id))
        };
    }
}

function saveConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Logic Scraper Core
const TRADE_ZONES = [
    { name: "OP", tradezone: 21 },
    { name: "CV", tradezone: 22 },
    { name: "SEZ", tradezone: 9 },
    { name: "NZ", tradezone: 2 },
    { name: "NWZ", tradezone: 1 },
    { name: "NEZ", tradezone: 3 },
    { name: "SWZ", tradezone: 7 },
    { name: "SZ", tradezone: 8 },
    { name: "WZ", tradezone: 4 },
    { name: "EZ", tradezone: 6 },
    { name: "CZ", tradezone: 5 }
];

let latestPrices = {}; // { profileId: [] }
let isRunning = {};    // { profileId: boolean }
let intervalRefs = {}; // { profileId: intervalId }
let priceCache = {};   // { 'itemName_zone_profileId': price }
let notifiedPriceCache = {}; // { 'itemName_zone_profileId': lastNotifiedPrice }
let lastMessageId = {}; // { profileId: messageId }
let lastBargainKeys = {}; // { profileId: string }

async function sendDiscordEmbed(webhook, itemsFound, zones, roleId) {
    if (!webhook || itemsFound.length === 0) return null;

    const embeds = zones.map(zone => {
        const zoneItems = itemsFound.filter(it => it.zone === zone.name);
        if (zoneItems.length === 0) return null;

        return {
            title: `📍 Khu vực: ${zone.name}`,
            color: 0x00ff88,
            fields: zoneItems.map(it => ({
                name: `📦 ${it.name}`,
                value: `💰 **Giá: $${it.price.toLocaleString()}**\n🚨 Ngưỡng báo: $${it.alertPrice.toLocaleString()}`,
                inline: true
            })),
            timestamp: new Date().toISOString(),
            footer: { text: "DF Marketplace Tracker Web Pro" }
        };
    }).filter(e => e !== null);

    if (embeds.length === 0) return null;

    try {
        const payload = { embeds };
        if (roleId) payload.content = `🔔 Phát hiện đồ giá rẻ!`;

        const res = await axios.post(webhook + "?wait=true", payload);
        return res.data.id;
    } catch (err) {
        console.error("Lỗi gửi Discord:", err.message);
        return null;
    }
}

async function deleteDiscordMessage(webhook, messageId) {
    if (!messageId || !webhook) return;
    try {
        await axios.delete(`${webhook}/messages/${messageId}`);
    } catch { }
}

async function searchItem(item, zoneId, cookie) {
    try {
        let cookieString = cookie;
        // Tự động thêm tiền tố nếu người dùng chỉ dán mỗi mã
        if (cookie && !cookie.includes("=")) {
            cookieString = `PHPSESSID=${cookie}`;
        }

        const res = await axios.post(
            "https://fairview.deadfrontier.com/onlinezombiemmo/trade_search.php",
            qs.stringify({
                tradezone: zoneId,
                searchname: item.searchTerm,
                searchtype: "buyinglistitemname",
                search: "trades",
                memID: "",
                profession: "",
                category: ""
            }),
            {
                timeout: 8000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": cookieString,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
            }
        );

        const raw = res.data;
        if (!raw || !raw.includes("tradelist_0_")) return null;

        const regex = /tradelist_(\d+)_itemname=([^&]*)&tradelist_\1_price=(\d+)/g;
        let match;
        let results = [];

        while ((match = regex.exec(raw)) !== null) {
            results.push({ name: decodeURIComponent(match[2]), price: parseInt(match[3]) });
        }

        if (!results.length) return null;
        results.sort((a, b) => a.price - b.price);
        return results[0];
    } catch (err) {
        return null;
    }
}

async function runCycle(profileId) {
    if (isRunning[profileId]) return;
    isRunning[profileId] = true;
    console.log(`--- Bắt đầu quét giá [Profile ${profileId}] ---`);

    try {
        const config = loadConfig();
        const profile = config.profiles.find(p => p.id === parseInt(profileId));

        if (!profile || !profile.cookie) {
            console.log(`⚠️ [Profile ${profileId}] Chưa có Cookie, dừng quét!`);
            isRunning[profileId] = false;
            return;
        }

        const items = profile.items || [];
        const selectedZones = (profile.selectedZones || []).map(i => TRADE_ZONES[i]);

        if (selectedZones.length === 0) selectedZones.push(TRADE_ZONES[0]);

        let updateTable = [];
        let currentBargains = [];
        let newHits = [];

        for (let zone of selectedZones) {
            console.log(`[Profile ${profileId}] Đang quét vùng: ${zone.name}...`);
            let zoneData = { zone: zone.name, items: [] };
            for (const item of items) {
                const cacheKey = `${item.searchTerm}_${zone.name}_${profileId}`;
                const result = await searchItem(item, zone.tradezone, profile.cookie);

                let currentPrice = result ? result.price : (priceCache[cacheKey] || null);
                let hitResult = null;

                if (result) {
                    priceCache[cacheKey] = result.price;
                    const isBelowThreshold = result.price <= item.alert;

                    if (isBelowThreshold) {
                        hitResult = {
                            ...result,
                            zone: zone.name,
                            alertPrice: item.alert
                        };
                        currentBargains.push(hitResult);

                        const hasPriceChanged = notifiedPriceCache[cacheKey] !== result.price;
                        if (item.alertEnabled !== false && hasPriceChanged) {
                            newHits.push(hitResult);
                            notifiedPriceCache[cacheKey] = result.price;
                        }
                    } else {
                        // Reset notification cache if price goes above alert
                        delete notifiedPriceCache[cacheKey];
                    }

                    console.log(`✅ [${zone.name} - P${profileId}] ${item.searchTerm}: $${result.price.toLocaleString()}`);
                } else {
                    console.log(`❌ [${zone.name} - P${profileId}] ${item.searchTerm}: N/A`);
                }

                const isNew = result && (notifiedPriceCache[cacheKey] !== result.price);

                zoneData.items.push({
                    name: result ? result.name : item.searchTerm,
                    price: currentPrice,
                    alert: hitResult !== null,
                    isNew: isNew
                });
            }
            updateTable.push(zoneData);
        }
        latestPrices[profileId] = updateTable;

        // Xử lý thông báo Discord
        const currentBargainKeys = currentBargains.map(b => `${b.name}_${b.zone}_${b.price}`).sort().join('|');
        const contentChanged = currentBargainKeys !== (lastBargainKeys[profileId] || "");

        if (profile.discordEnabled) {
            if (newHits.length > 0 || contentChanged) {
                // Có thay đổi (đồ mới, đổi giá, hoặc đồ cũ biến mất)
                if (lastMessageId[profileId]) {
                    await deleteDiscordMessage(profile.webhook, lastMessageId[profileId]);
                }

                if (currentBargains.length > 0) {
                    const shouldTag = newHits.length > 0;
                    lastMessageId[profileId] = await sendDiscordEmbed(
                        profile.webhook,
                        currentBargains,
                        selectedZones,
                        shouldTag ? profile.roleId : "" // Chỉ truyền RoleId nếu cần Tag
                    );
                    lastBargainKeys[profileId] = currentBargainKeys;
                } else {
                    lastMessageId[profileId] = null;
                    lastBargainKeys[profileId] = "";
                }
            }
        }

        console.log(`--- Quét xong [Profile ${profileId}] ---`);
    } catch (err) {
        console.error(`🔥 Lỗi vòng lặp [Profile ${profileId}]:`, err.message);
    } finally {
        isRunning[profileId] = false;
    }
}

// API Endpoints
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const config = loadConfig();
    if (password === (config.password || ADMIN_PASSWORD)) {
        const token = Math.random().toString(36).substring(7);
        sessions.add(token);
        res.json({ success: true, token });
    } else {
        res.json({ success: false, message: "Sai mật khẩu" });
    }
});

const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (sessions.has(token)) next();
    else res.status(401).json({ message: "Chưa đăng nhập" });
};

// GET full config
app.get('/api/config', auth, (req, res) => {
    res.json(loadConfig());
});

// POST full config
app.post('/api/config', auth, (req, res) => {
    saveConfig(req.body);
    res.json({ success: true });
});

// Export config file
app.get('/api/config/export', auth, (req, res) => {
    res.download(configPath, 'config.json');
});

// Add new profile
app.post('/api/profile/add', auth, (req, res) => {
    const config = loadConfig();
    const nextId = config.profiles.length > 0 ? Math.max(...config.profiles.map(p => p.id)) + 1 : 1;
    const newProfile = createDefaultProfile(nextId);
    config.profiles.push(newProfile);
    saveConfig(config);
    res.json({ success: true, profile: newProfile });
});

// Delete profile
app.post('/api/profile/delete', auth, (req, res) => {
    const { profileId } = req.body;
    const config = loadConfig();
    const index = config.profiles.findIndex(p => p.id === parseInt(profileId));

    if (index === -1) return res.status(400).json({ error: "Profile not found" });
    if (config.profiles.length <= 1) return res.status(400).json({ error: "Cannot delete the last profile" });

    // Stop scraper if running
    if (intervalRefs[profileId]) {
        clearInterval(intervalRefs[profileId]);
        delete intervalRefs[profileId];
    }

    config.profiles.splice(index, 1);
    saveConfig(config);
    res.json({ success: true });
});

app.get('/api/status', auth, (req, res) => {
    const pId = req.query.profileId || 1;
    res.json({
        isRunning: !!intervalRefs[pId],
        isScanning: !!isRunning[pId],
        lastUpdate: new Date().toLocaleTimeString()
    });
});

app.get('/api/prices', auth, (req, res) => {
    const pId = req.query.profileId || 1;
    res.json(latestPrices[pId] || []);
});

app.post('/api/start', auth, async (req, res) => {
    const pId = req.body.profileId || 1;
    if (intervalRefs[pId]) return res.json({ success: true });

    const config = loadConfig();
    const profile = config.profiles.find(p => p.id === parseInt(pId));

    if (!profile) return res.status(400).json({ error: "Profile not found" });

    runCycle(pId);

    intervalRefs[pId] = setInterval(() => runCycle(pId), profile.interval || 60000);
    res.json({ success: true });
});

app.post('/api/refresh', auth, async (req, res) => {
    const pId = req.body.profileId || 1;
    await runCycle(pId);
    res.json({ success: true });
});

app.post('/api/stop', auth, (req, res) => {
    const pId = req.body.profileId || 1;
    if (intervalRefs[pId]) {
        clearInterval(intervalRefs[pId]);
        intervalRefs[pId] = null;
    }
    res.json({ success: true });
});
app.listen(PORT, () => {
    console.log(`Web Scraper Pro running at http://localhost:${PORT}`);

    // Tự động khởi chạy tất cả Profile có Cookie khi Server boot
    const config = loadConfig();
    config.profiles.forEach(profile => {
        if (profile.cookie) {
            console.log(`🚀 Tự động chạy Profile ${profile.id}...`);
            runCycle(profile.id);
            intervalRefs[profile.id] = setInterval(() => runCycle(profile.id), profile.interval || 60000);
        }
    });
});
