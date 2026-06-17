// server.js - Version finale avec toutes les corrections
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? undefined : { rejectUnauthorized: false }
});

pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'America/Port-au-Prince'", (err) => {
        if (err) console.error('❌ Erreur fuseau:', err);
    });
});

const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_long_et_securise';

// ==================== Création et mise à jour des tables ====================
async function initTables() {
    await pool.query(`CREATE TABLE IF NOT EXISTS owners (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, username VARCHAR(50) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, blocked BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW())`);
    const ownerExists = await pool.query('SELECT id FROM owners LIMIT 1');
    if (ownerExists.rows.length === 0) {
        const hashed = await bcrypt.hash('admin123', 10);
        await pool.query(`INSERT INTO owners (name, username, password) VALUES ($1, $2, $3)`, ['Administrateur', 'admin', hashed]);
        console.log('✅ Propriétaire par défaut: admin / admin123');
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS players (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, phone VARCHAR(20) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, zone VARCHAR(100), balance DECIMAL(10,2) DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS draws (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, time TIME NOT NULL, active BOOLEAN DEFAULT true)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS winning_results (id SERIAL PRIMARY KEY, draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE, numbers JSONB, lotto3 VARCHAR(3), date TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, player_id INTEGER REFERENCES players(id) ON DELETE SET NULL, draw_id INTEGER REFERENCES draws(id) ON DELETE SET NULL, draw_name VARCHAR(100), ticket_id VARCHAR(50) UNIQUE, total_amount DECIMAL(10,2) DEFAULT 0, win_amount DECIMAL(10,2) DEFAULT 0, win_details JSONB, paid BOOLEAN DEFAULT false, checked BOOLEAN DEFAULT false, bets JSONB, date TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, player_id INTEGER REFERENCES players(id) ON DELETE CASCADE, type VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdraw','bet','win')), amount DECIMAL(10,2) NOT NULL, method VARCHAR(20), description TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS recharge_codes (id SERIAL PRIMARY KEY, code VARCHAR(32) UNIQUE, amount DECIMAL(10,2) NOT NULL, used BOOLEAN DEFAULT false, used_by_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW(), used_at TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS lottery_settings (id SERIAL PRIMARY KEY, name VARCHAR(100), slogan TEXT, logo_url TEXT, multipliers JSONB, limits JSONB, ads_images JSONB, announcements TEXT)`);
    await pool.query(`ALTER TABLE lottery_settings ADD COLUMN IF NOT EXISTS advanced_settings JSONB`);
    const settingsCount = await pool.query('SELECT COUNT(*) FROM lottery_settings');
    if (parseInt(settingsCount.rows[0].count) === 0) {
        await pool.query(`INSERT INTO lottery_settings (name, slogan, multipliers, ads_images, announcements, advanced_settings) VALUES ('LOTATO PRO', 'La loterie qui fait gagner', '{"lot1":90,"lot2":50,"lot3":30,"lotto3":500,"lotto4":5000,"lotto5":25000,"mariage":500}', '[]', '', '{"freeMarriage":{"tiers":[{"min":0,"max":50,"count":1},{"min":51,"max":150,"count":2},{"min":151,"max":null,"count":3}],"winAmount":2500}}')`);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS global_number_limits (number VARCHAR(2) NOT NULL PRIMARY KEY, limit_amount DECIMAL(10,2) NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS global_blocked_numbers (number VARCHAR(2) PRIMARY KEY)`);
    const drawsCount = await pool.query('SELECT COUNT(*) FROM draws');
    if (parseInt(drawsCount.rows[0].count) === 0) {
        const defaultDraws = [
            ['Tunisia Matin', '10:00:00', true], ['Tunisia Soir', '19:25:00', true],
            ['Florida Matin', '13:30:00', true], ['Florida Soir', '21:50:00', true],
            ['New York Matin', '14:30:00', true], ['New York Soir', '22:28:00', true],
            ['Georgia Matin', '12:30:00', true], ['Georgia Soir', '19:00:00', true],
            ['Texas Matin', '10:55:00', true], ['Texas Soir', '18:58:00', true]
        ];
        for (const [name, time, active] of defaultDraws) {
            await pool.query('INSERT INTO draws (name, time, active) VALUES ($1, $2, $3)', [name, time, active]);
        }
        console.log('✅ 10 tirages par défaut créés');
    }
    console.log('✅ Tables prêtes');
}

// ==================== Cron fermeture 7 minutes avant ====================
cron.schedule('* * * * *', async () => {
    try {
        const result = await pool.query(`
            UPDATE draws SET active = false
            WHERE active = true
              AND (CURRENT_DATE + time - INTERVAL '7 minutes') <= NOW() AT TIME ZONE 'America/Port-au-Prince'
              AND (CURRENT_DATE + time) > NOW() AT TIME ZONE 'America/Port-au-Prince' - INTERVAL '1 day'
        `);
        if (result.rowCount > 0) console.log(`🔒 ${result.rowCount} tirage(s) fermé(s) (7 min avant)`);
    } catch (err) { console.error('❌ Erreur cron:', err); }
});

function scheduleMidnightReactivation() {
    const now = moment().tz('America/Port-au-Prince');
    const midnight = moment.tz('America/Port-au-Prince').endOf('day').add(1, 'millisecond');
    const delay = midnight.diff(now);
    setTimeout(async () => {
        try {
            await pool.query(`UPDATE draws SET active = true WHERE active = false`);
            console.log(`✅ Tous les tirages réactivés à minuit HT`);
        } catch (err) { console.error('❌ Erreur réactivation:', err); }
        finally { scheduleMidnightReactivation(); }
    }, delay);
    console.log(`⏰ Prochaine réactivation à ${midnight.format('HH:mm')} HT`);
}

// ==================== Middleware ====================
const authenticateOwner = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'owner') return res.status(403).json({ error: 'Accès propriétaire requis' });
        req.user = decoded;
        next();
    } catch (err) { return res.status(401).json({ error: 'Token invalide' }); }
};

const authenticatePlayer = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'player') return res.status(403).json({ error: 'Accès joueur requis' });
        req.player = decoded;
        next();
    } catch (err) { return res.status(401).json({ error: 'Token invalide' }); }
};

// ==================== Routes d'authentification ====================
app.post('/api/auth/player/register', async (req, res) => {
    const { name, phone, password, zone } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Nom, téléphone et mot de passe requis' });
    try {
        const existing = await pool.query('SELECT id FROM players WHERE phone = $1', [phone]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Ce numéro est déjà utilisé' });
        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.query(`INSERT INTO players (name, phone, password, zone, balance) VALUES ($1, $2, $3, $4, 50) RETURNING id, name, phone, balance`, [name, phone, hashed, zone || null]);
        const player = result.rows[0];
        await pool.query(`INSERT INTO transactions (player_id, type, amount, description) VALUES ($1, 'deposit', 50, 'Bonus de bienvenue 50 G')`, [player.id]);
        const token = jwt.sign({ id: player.id, role: 'player', name: player.name, phone: player.phone }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, playerId: player.id, name: player.name, balance: parseFloat(player.balance) });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    const ownerResult = await pool.query('SELECT id, name, username, password FROM owners WHERE username = $1', [identifier]);
    if (ownerResult.rows.length > 0) {
        const owner = ownerResult.rows[0];
        if (await bcrypt.compare(password, owner.password)) {
            const token = jwt.sign({ id: owner.id, role: 'owner', name: owner.name }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, token, role: 'owner', name: owner.name });
        }
    }
    const playerResult = await pool.query('SELECT id, name, phone, password, balance FROM players WHERE phone = $1', [identifier]);
    if (playerResult.rows.length > 0) {
        const player = playerResult.rows[0];
        if (await bcrypt.compare(password, player.password)) {
            const token = jwt.sign({ id: player.id, role: 'player', name: player.name, phone: player.phone }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, token, role: 'player', playerId: player.id, name: player.name, balance: parseFloat(player.balance) });
        }
    }
    return res.status(401).json({ error: 'Identifiants incorrects' });
});

// ==================== Routes propriétaire ====================
app.get('/api/owner/draws', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
    res.json(result.rows);
});
app.put('/api/owner/draws/:id/toggle', authenticateOwner, async (req, res) => {
    await pool.query('UPDATE draws SET active = NOT active WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});
app.post('/api/owner/publish-results', authenticateOwner, async (req, res) => {
    console.log('📢 Publication résultats - body reçu:', req.body);
    const { drawId, numbers, lotto3 } = req.body;
    if (!drawId || !numbers || !lotto3) {
        return res.status(400).json({ error: 'Données incomplètes' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO winning_results (draw_id, numbers, lotto3) VALUES ($1, $2, $3)`,
            [drawId, JSON.stringify(numbers), lotto3]
        );
        const ticketsRes = await client.query(
            `SELECT * FROM tickets WHERE draw_id = $1 AND checked = false`,
            [drawId]
        );
        console.log(`📄 ${ticketsRes.rows.length} tickets à traiter`);
        for (const ticket of ticketsRes.rows) {
            await client.query(
                `UPDATE tickets SET checked = true WHERE id = $1`,
                [ticket.id]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Résultats publiés' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur publication:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});
app.get('/api/owner/global-limits', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT number, limit_amount FROM global_number_limits');
    res.json(result.rows);
});
app.post('/api/owner/global-limits', authenticateOwner, async (req, res) => {
    const { number, limitAmount } = req.body;
    if (!number || !limitAmount) return res.status(400).json({ error: 'Numéro et montant requis' });
    await pool.query(`INSERT INTO global_number_limits (number, limit_amount) VALUES ($1,$2) ON CONFLICT (number) DO UPDATE SET limit_amount=$2`, [number, limitAmount]);
    res.json({ success: true });
});
app.delete('/api/owner/global-limits/:number', authenticateOwner, async (req, res) => {
    await pool.query('DELETE FROM global_number_limits WHERE number = $1', [req.params.number]);
    res.json({ success: true });
});
app.get('/api/owner/blocked-numbers', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT number FROM global_blocked_numbers');
    res.json({ blockedNumbers: result.rows.map(r => r.number) });
});
app.post('/api/owner/block-number', authenticateOwner, async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Numéro requis' });
    await pool.query('INSERT INTO global_blocked_numbers (number) VALUES ($1) ON CONFLICT DO NOTHING', [number]);
    res.json({ success: true });
});
app.post('/api/owner/unblock-number', authenticateOwner, async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Numéro requis' });
    await pool.query('DELETE FROM global_blocked_numbers WHERE number = $1', [number]);
    res.json({ success: true });
});
app.get('/api/owner/settings', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT name, slogan, logo_url, multipliers, ads_images, announcements, advanced_settings FROM lottery_settings LIMIT 1');
    if (result.rows.length) {
        const r = result.rows[0];
        res.json({ name: r.name, slogan: r.slogan, logoUrl: r.logo_url, multipliers: r.multipliers, adsImages: r.ads_images, announcements: r.announcements, advancedSettings: r.advanced_settings });
    } else res.json({});
});
app.post('/api/owner/settings', authenticateOwner, async (req, res) => {
    const { name, slogan, logoUrl, multipliers, adsImages, announcements, advancedSettings } = req.body;
    await pool.query(`UPDATE lottery_settings SET name=$1, slogan=$2, logo_url=$3, multipliers=$4, ads_images=$5, announcements=$6, advanced_settings=$7 WHERE id=1`, [name, slogan, logoUrl, multipliers, adsImages, announcements, advancedSettings]);
    res.json({ success: true });
});
app.post('/api/owner/generate-recharge-code', authenticateOwner, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant valide requis' });
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    await pool.query('INSERT INTO recharge_codes (code, amount) VALUES ($1, $2)', [code, amount]);
    res.json({ success: true, code, amount });
});
app.get('/api/owner/stats', authenticateOwner, async (req, res) => {
    const players = await pool.query('SELECT COUNT(*) FROM players');
    const tickets = await pool.query('SELECT COUNT(*) FROM tickets');
    const betsTotal = await pool.query('SELECT SUM(total_amount) as total FROM tickets');
    const winsTotal = await pool.query('SELECT SUM(win_amount) as total FROM tickets');
    const recharges = await pool.query('SELECT SUM(amount) as total FROM transactions WHERE type = \'deposit\'');
    res.json({
        totalPlayers: parseInt(players.rows[0].count),
        totalTickets: parseInt(tickets.rows[0].count),
        totalBets: parseFloat(betsTotal.rows[0].total || 0),
        totalWins: parseFloat(winsTotal.rows[0].total || 0),
        totalRecharges: parseFloat(recharges.rows[0].total || 0)
    });
});
app.get('/api/owner/players', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT id, name, phone, zone, balance, created_at FROM players ORDER BY created_at DESC');
    res.json(result.rows);
});
app.get('/api/owner/tickets', authenticateOwner, async (req, res) => {
    const result = await pool.query(`SELECT t.id, t.ticket_id, t.draw_name, t.total_amount, t.win_amount, t.checked, t.date, p.name as player_name, p.phone 
        FROM tickets t LEFT JOIN players p ON t.player_id = p.id ORDER BY t.date DESC`);
    res.json(result.rows);
});
app.delete('/api/owner/tickets/:id', authenticateOwner, async (req, res) => {
    await pool.query('DELETE FROM tickets WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});
app.post('/api/owner/reports', authenticateOwner, async (req, res) => {
    console.log('📊 Rapport - body reçu:', req.body);
    const { startDate, endDate } = req.body;
    try {
        let where = '';
        let params = [];
        if (startDate && endDate) {
            where = 'WHERE date >= $1 AND date <= $2';
            params = [startDate, endDate];
        }
        const bets = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM tickets ${where}`, params);
        const wins = await pool.query(`SELECT COALESCE(SUM(win_amount),0) as total FROM tickets ${where}`, params);
        const deposits = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='deposit' ${where ? 'AND ' + where.substring(6) : ''}`, params);
        const winsTrans = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='win' ${where ? 'AND ' + where.substring(6) : ''}`, params);
        res.json({
            totalBets: parseFloat(bets.rows[0].total),
            totalWins: parseFloat(wins.rows[0].total),
            totalDeposits: parseFloat(deposits.rows[0].total),
            totalWinsTransactions: parseFloat(winsTrans.rows[0].total),
            netProfit: parseFloat(bets.rows[0].total) - parseFloat(winsTrans.rows[0].total)
        });
    } catch (err) {
        console.error('❌ Erreur rapport:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== Routes joueur ====================
app.get('/api/player/balance', authenticatePlayer, async (req, res) => {
    const result = await pool.query('SELECT balance FROM players WHERE id = $1', [req.player.id]);
    res.json({ balance: parseFloat(result.rows[0].balance) });
});
app.get('/api/draws', authenticatePlayer, async (req, res) => {
    const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
    res.json({ draws: result.rows });
});
app.get('/api/player/settings', authenticatePlayer, async (req, res) => {
    try {
        const settings = await pool.query(
            `SELECT name, slogan, logo_url, multipliers, announcements, ads_images, advanced_settings 
             FROM lottery_settings LIMIT 1`
        );
        const limits = await pool.query('SELECT number, limit_amount FROM global_number_limits');
        const blocked = await pool.query('SELECT number FROM global_blocked_numbers');
        const globalLimits = {};
        limits.rows.forEach(l => { globalLimits[l.number] = parseFloat(l.limit_amount); });
        const row = settings.rows[0] || {};
        res.json({
            name: row.name || 'LOTATO',
            slogan: row.slogan || '',
            logoUrl: row.logo_url || '',
            multipliers: row.multipliers || {},
            announcements: row.announcements || '',
            adsImages: row.ads_images || [],
            globalLimits,
            blockedNumbers: blocked.rows.map(b => b.number),
            advancedSettings: row.advanced_settings || {}
        });
    } catch (err) {
        console.error('❌ Erreur settings:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ROUTE PRINCIPALE CORRIGÉE ====================
app.post('/api/player/tickets/save', authenticatePlayer, async (req, res) => {
    console.log('📥 Sauvegarde ticket - body reçu :', JSON.stringify(req.body).slice(0, 200));
    const { drawId, drawName, bets, totalAmount } = req.body;
    if (!drawId || !bets || totalAmount === undefined) {
        return res.status(400).json({ error: 'Données incomplètes (drawId, bets, totalAmount requis)' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const drawRes = await client.query('SELECT id, time, active FROM draws WHERE id = $1', [drawId]);
        if (drawRes.rows.length === 0) throw new Error('Tirage introuvable');
        const draw = drawRes.rows[0];
        if (!draw.active) throw new Error('Ce tirage est fermé (désactivé)');
        let hour = 0, minute = 0;
        const timeVal = draw.time;
        if (typeof timeVal === 'string') {
            const parts = timeVal.split(':');
            hour = parseInt(parts[0]);
            minute = parseInt(parts[1]);
        } else if (timeVal instanceof Date) {
            hour = timeVal.getHours();
            minute = timeVal.getMinutes();
        } else if (timeVal && typeof timeVal === 'object') {
            hour = timeVal.getHours ? timeVal.getHours() : 0;
            minute = timeVal.getMinutes ? timeVal.getMinutes() : 0;
        }
        const now = moment().tz('America/Port-au-Prince');
        const drawDateTime = now.clone().set({ hour, minute, second: 0 });
        const blockFrom = drawDateTime.clone().subtract(7, 'minutes');
        console.log(`🕒 Heure actuelle: ${now.format('HH:mm:ss')} | Tirage à: ${drawDateTime.format('HH:mm:ss')} | Blocage depuis: ${blockFrom.format('HH:mm:ss')}`);
        if (now.isAfter(drawDateTime)) throw new Error(`Tirage déjà passé (heure ${drawDateTime.format('HH:mm')})`);
        if (now.isSameOrAfter(blockFrom)) throw new Error(`Tirage fermé depuis ${blockFrom.format('HH:mm')} (7 minutes avant)`);
        const balanceRes = await client.query('SELECT balance FROM players WHERE id = $1 FOR UPDATE', [req.player.id]);
        const balance = parseFloat(balanceRes.rows[0].balance);
        if (balance < totalAmount) throw new Error(`Solde insuffisant: ${balance} G, besoin de ${totalAmount} G`);
        await client.query('UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [totalAmount, req.player.id]);
        const advRes = await client.query('SELECT advanced_settings FROM lottery_settings LIMIT 1');
        let tiers = [{ min: 0, max: 50, count: 1 }, { min: 51, max: 150, count: 2 }, { min: 151, max: null, count: 3 }];
        if (advRes.rows[0]?.advanced_settings?.freeMarriage?.tiers) {
            tiers = advRes.rows[0].advanced_settings.freeMarriage.tiers;
        }
        const paidAmount = bets.filter(b => !b.free).reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
        let freeCount = 0;
        for (const tier of tiers) {
            if ((tier.max === null && paidAmount >= tier.min) || (tier.max !== null && paidAmount >= tier.min && paidAmount <= tier.max)) {
                freeCount = tier.count;
                break;
            }
        }
        const freeBets = [];
        for (let i = 0; i < freeCount; i++) {
            const n1 = Math.floor(Math.random() * 100).toString().padStart(2, '0');
            const n2 = Math.floor(Math.random() * 100).toString().padStart(2, '0');
            freeBets.push({
                game: 'auto_marriage',
                number: `${n1}&${n2}`,
                cleanNumber: `${n1}${n2}`,
                amount: 0,
                free: true,
                freeType: 'special_marriage',
                freeWin: 2500
            });
        }
        const normalizedBets = bets.map(b => ({
            ...b,
            game: b.game || (b.specialType || 'borlette'),
            cleanNumber: b.cleanNumber || (b.number ? String(b.number).replace(/[^0-9&]/g, '') : ''),
            number: b.number || b.cleanNumber,
            amount: parseFloat(b.amount) || 0
        }));
        const finalBets = [...normalizedBets, ...freeBets];
        const finalTotal = finalBets.reduce((s, b) => s + (b.amount || 0), 0);
        const ticketId = 'TKT' + Date.now() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await client.query(
            `INSERT INTO tickets (player_id, draw_id, draw_name, ticket_id, total_amount, bets, checked)
             VALUES ($1, $2, $3, $4, $5, $6, false)`,
            [req.player.id, drawId, drawName, ticketId, finalTotal, JSON.stringify(finalBets)]
        );
        await client.query(
            `INSERT INTO transactions (player_id, type, amount, description) VALUES ($1, 'bet', $2, $3)`,
            [req.player.id, totalAmount, `Achat ticket ${ticketId} - ${drawName}`]
        );
        await client.query('COMMIT');
        console.log(`✅ Ticket ${ticketId} créé (${freeCount} mariages gratuits)`);
        res.json({ success: true, ticketId, freeBetsAdded: freeCount });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ ERREUR dans /api/player/tickets/save :', err.message);
        if (!res.headersSent) {
            res.status(403).json({ error: err.message });
        }
    } finally {
        client.release();
    }
});

app.get('/api/player/tickets', authenticatePlayer, async (req, res) => {
    console.log('📋 Tickets pour joueur:', req.player.id);
    try {
        const result = await pool.query(
            `SELECT id, draw_name, total_amount, win_amount, win_details, checked, bets, date 
             FROM tickets WHERE player_id = $1 ORDER BY date DESC`,
            [req.player.id]
        );
        const tickets = result.rows.map(t => ({
            ...t,
            win_details: typeof t.win_details === 'string' ? JSON.parse(t.win_details) : t.win_details,
            bets: typeof t.bets === 'string' ? JSON.parse(t.bets) : t.bets
        }));
        console.log(`✅ ${tickets.length} ticket(s) trouvés`);
        res.json({ tickets });
    } catch (err) {
        console.error('❌ Erreur récupération tickets:', err);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/winners/results', authenticatePlayer, async (req, res) => {
    const results = await pool.query(`SELECT w.*, d.name FROM winning_results w JOIN draws d ON w.draw_id = d.id ORDER BY w.date DESC LIMIT 50`);
    res.json({ results: results.rows });
});
app.post('/api/player/recharge/code', authenticatePlayer, async (req, res) => {
    const { code } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const codeRes = await client.query('SELECT id, amount, used FROM recharge_codes WHERE code = $1 FOR UPDATE', [code]);
        if (codeRes.rows.length === 0) throw new Error('Code invalide');
        const rc = codeRes.rows[0];
        if (rc.used) throw new Error('Code déjà utilisé');
        await client.query('UPDATE recharge_codes SET used = true, used_by_player_id = $1, used_at = NOW() WHERE id = $2', [req.player.id, rc.id]);
        await client.query('UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [rc.amount, req.player.id]);
        await client.query('INSERT INTO transactions (player_id, type, amount, method, description) VALUES ($1, $2, $3, $4, $5)', [req.player.id, 'deposit', rc.amount, 'code', `Recharge code ${code}`]);
        await client.query('COMMIT');
        res.json({ success: true, amount: parseFloat(rc.amount) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ==================== Démarrage ====================
initTables().then(() => {
    scheduleMidnightReactivation();
    app.listen(port, '0.0.0.0', () => {
        console.log(`🚀 Serveur LOTATO démarré sur http://0.0.0.0:${port}`);
    });
}).catch(err => {
    console.error('❌ Impossible de démarrer:', err);
    process.exit(1);
});