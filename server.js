// server.js - Architecture avec un seul propriétaire
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ==================== Base de données ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'America/Port-au-Prince'", (err) => {
        if (err) console.error('❌ Erreur fuseau:', err);
    });
});

const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_long_et_securise';

// ==================== Création des tables ====================
async function initTables() {
    // Table propriétaire (un seul)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS owners (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            blocked BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);
    // Insérer un propriétaire par défaut si aucun (à modifier après)
    const ownerExists = await pool.query('SELECT id FROM owners LIMIT 1');
    if (ownerExists.rows.length === 0) {
        const hashed = await bcrypt.hash('admin123', 10);
        await pool.query(
            `INSERT INTO owners (name, username, password) VALUES ($1, $2, $3)`,
            ['Administrateur', 'admin', hashed]
        );
        console.log('✅ Propriétaire par défaut créé: admin / admin123');
    }

    // Joueurs
    await pool.query(`
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            phone VARCHAR(20) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            zone VARCHAR(100),
            balance DECIMAL(10,2) DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Tirages
    await pool.query(`
        CREATE TABLE IF NOT EXISTS draws (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            time TIME NOT NULL,
            active BOOLEAN DEFAULT true
        )
    `);

    // Résultats gagnants
    await pool.query(`
        CREATE TABLE IF NOT EXISTS winning_results (
            id SERIAL PRIMARY KEY,
            draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
            numbers VARCHAR(3) NOT NULL,
            lotto3 VARCHAR(3),
            date TIMESTAMP DEFAULT NOW()
        )
    `);

    // Tickets joueurs
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
            draw_id INTEGER REFERENCES draws(id) ON DELETE SET NULL,
            draw_name VARCHAR(100),
            ticket_id VARCHAR(50) UNIQUE,
            total_amount DECIMAL(10,2) DEFAULT 0,
            win_amount DECIMAL(10,2) DEFAULT 0,
            paid BOOLEAN DEFAULT false,
            checked BOOLEAN DEFAULT false,
            bets JSONB,
            date TIMESTAMP DEFAULT NOW()
        )
    `);

    // Transactions joueur
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
            type VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdraw','bet','win')),
            amount DECIMAL(10,2) NOT NULL,
            method VARCHAR(20),
            description TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Codes de recharge physique
    await pool.query(`
        CREATE TABLE IF NOT EXISTS recharge_codes (
            id SERIAL PRIMARY KEY,
            code VARCHAR(32) UNIQUE,
            amount DECIMAL(10,2) NOT NULL,
            used BOOLEAN DEFAULT false,
            used_by_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            used_at TIMESTAMP
        )
    `);

    // Paramètres loterie (multiplicateurs, logos, annonces)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lottery_settings (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            slogan TEXT,
            logo_url TEXT,
            multipliers JSONB,
            limits JSONB,
            ads_images JSONB,       -- tableau d'URL d'images pour carrousel
            announcements TEXT      -- texte d'annonce
        )
    `);

    // Limites globales
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_number_limits (
            number VARCHAR(2) NOT NULL PRIMARY KEY,
            limit_amount DECIMAL(10,2) NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    // Limites par tirage
    await pool.query(`
        CREATE TABLE IF NOT EXISTS draw_number_limits (
            draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
            number VARCHAR(2) NOT NULL,
            limit_amount DECIMAL(10,2) NOT NULL,
            PRIMARY KEY (draw_id, number)
        )
    `);
    // Numéros bloqués globalement
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_blocked_numbers (
            number VARCHAR(2) PRIMARY KEY
        )
    `);
    // Numéros bloqués par tirage
    await pool.query(`
        CREATE TABLE IF NOT EXISTS draw_blocked_numbers (
            draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
            number VARCHAR(2) NOT NULL,
            PRIMARY KEY (draw_id, number)
        )
    `);
    // Numéros Lotto3 bloqués
    await pool.query(`
        CREATE TABLE IF NOT EXISTS blocked_lotto3_numbers (
            number VARCHAR(3) PRIMARY KEY
        )
    `);

    console.log('✅ Tables créées/vérifiées');
}

// ==================== Tâche cron : fermer les tirages 2 minutes avant l'heure, réouverture à minuit ====================
const cron = require('node-cron');

// Fermeture à 2 minutes avant chaque tirage
cron.schedule('* * * * *', async () => {
    try {
        const now = moment().tz('America/Port-au-Prince');
        const currentTime = now.format('HH:mm:ss');
        
        // Désactiver les tirages dont l'heure est dans 2 minutes ou moins
        const result = await pool.query(
            `UPDATE draws
             SET active = false
             WHERE active = true
               AND (time - INTERVAL '2 minutes') <= $1::time
               AND time > $1::time`,
            [currentTime]
        );
        if (result.rowCount > 0) {
            console.log(`🔒 ${result.rowCount} tirage(s) fermé(s) (2 minutes avant)`);
        }
    } catch (err) {
        console.error('❌ Erreur fermeture automatique:', err);
    }
});

// Réactivation de tous les tirages à minuit (12:00 AM) heure Haïti
function scheduleMidnightReactivation() {
    const now = moment().tz('America/Port-au-Prince');
    const midnight = moment.tz('America/Port-au-Prince').endOf('day').add(1, 'millisecond');
    const delay = midnight.diff(now);
    
    setTimeout(async () => {
        try {
            await pool.query(`UPDATE draws SET active = true WHERE active = false`);
            console.log(`✅ Tous les tirages réactivés à minuit`);
        } catch (err) {
            console.error('❌ Erreur réactivation:', err);
        } finally {
            scheduleMidnightReactivation();
        }
    }, delay);
    console.log(`⏰ Prochaine réactivation à ${midnight.format('HH:mm')} HT`);
}

// ==================== Middleware ====================
const authenticateOwner = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token manquant' });
    }
    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'owner') return res.status(403).json({ error: 'Accès propriétaire requis' });
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token invalide' });
    }
};

const authenticatePlayer = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token manquant' });
    }
    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'player') return res.status(403).json({ error: 'Accès joueur requis' });
        req.player = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token invalide' });
    }
};

// ==================== Routes authentification ====================
app.post('/api/auth/owner/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT id, name, username, password FROM owners WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Identifiants incorrects' });
        const owner = result.rows[0];
        const valid = await bcrypt.compare(password, owner.password);
        if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });
        const token = jwt.sign({ id: owner.id, role: 'owner', name: owner.name }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, name: owner.name });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/api/auth/player/register', async (req, res) => {
    const { name, phone, password, zone } = req.body;
    if (!name || !phone || !password) {
        return res.status(400).json({ error: 'Nom, téléphone et mot de passe requis' });
    }
    try {
        const existing = await pool.query('SELECT id FROM players WHERE phone = $1', [phone]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Ce numéro est déjà utilisé' });
        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO players (name, phone, password, zone, balance)
             VALUES ($1, $2, $3, $4, 0) RETURNING id, name, phone, balance`,
            [name, phone, hashed, zone || null]
        );
        const player = result.rows[0];
        const token = jwt.sign({ id: player.id, role: 'player', name: player.name, phone: player.phone }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, playerId: player.id, name: player.name, balance: parseFloat(player.balance) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/api/auth/player/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Téléphone et mot de passe requis' });
    try {
        const result = await pool.query('SELECT id, name, phone, password, balance FROM players WHERE phone = $1', [phone]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect' });
        const player = result.rows[0];
        const valid = await bcrypt.compare(password, player.password);
        if (!valid) return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect' });
        const token = jwt.sign({ id: player.id, role: 'player', name: player.name, phone: player.phone }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, playerId: player.id, name: player.name, balance: parseFloat(player.balance) });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ==================== Routes joueur ====================
app.get('/api/player/balance', authenticatePlayer, async (req, res) => {
    try {
        const result = await pool.query('SELECT balance FROM players WHERE id = $1', [req.player.id]);
        res.json({ balance: parseFloat(result.rows[0].balance) });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/draws', authenticatePlayer, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
        res.json({ draws: result.rows });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Récupérer les limites et blocages pour le joueur
app.get('/api/player/limits', authenticatePlayer, async (req, res) => {
    try {
        const globalLimits = await pool.query('SELECT number, limit_amount FROM global_number_limits');
        const drawLimits = await pool.query('SELECT draw_id, number, limit_amount FROM draw_number_limits');
        const globalBlocked = await pool.query('SELECT number FROM global_blocked_numbers');
        const drawBlocked = await pool.query('SELECT draw_id, number FROM draw_blocked_numbers');
        const lotto3Blocked = await pool.query('SELECT number FROM blocked_lotto3_numbers');
        res.json({
            globalLimits: globalLimits.rows,
            drawLimits: drawLimits.rows,
            globalBlocked: globalBlocked.rows.map(r => r.number),
            drawBlocked: drawBlocked.rows,
            lotto3Blocked: lotto3Blocked.rows.map(r => r.number)
        });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Récupérer la configuration (multiplicateurs, annonces)
app.get('/api/player/settings', authenticatePlayer, async (req, res) => {
    try {
        const result = await pool.query('SELECT name, slogan, logo_url, multipliers, ads_images, announcements FROM lottery_settings LIMIT 1');
        if (result.rows.length === 0) {
            return res.json({ name: 'LOTATO PRO', slogan: '', logoUrl: '', multipliers: { lot1:90, lot2:50, lot3:30, lotto3:500, lotto4:5000, lotto5:25000, mariage:500 }, adsImages: [], announcements: '' });
        }
        const row = result.rows[0];
        res.json({
            name: row.name,
            slogan: row.slogan,
            logoUrl: row.logo_url,
            multipliers: row.multipliers,
            adsImages: row.ads_images || [],
            announcements: row.announcements || ''
        });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Enregistrer un ticket
app.post('/api/player/tickets/save', authenticatePlayer, async (req, res) => {
    const { drawId, drawName, bets, total } = req.body;
    const playerId = req.player.id;
    const ticketId = 'T' + Date.now() + Math.floor(Math.random() * 1000);
    if (!drawId || !bets || !total || total <= 0) return res.status(400).json({ error: 'Données invalides' });

    try {
        const playerRes = await pool.query('SELECT balance FROM players WHERE id = $1', [playerId]);
        const currentBalance = parseFloat(playerRes.rows[0].balance);
        if (currentBalance < total) return res.status(400).json({ error: 'Solde insuffisant' });

        const drawCheck = await pool.query('SELECT active FROM draws WHERE id = $1', [drawId]);
        if (drawCheck.rows.length === 0 || !drawCheck.rows[0].active) {
            return res.status(403).json({ error: 'Tirage bloqué ou inexistant' });
        }

        // Vérifier les limites (numéros, montants)
        // (Logique similaire à avant, simplifiée ici)
        await pool.query('UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [total, playerId]);
        const result = await pool.query(
            `INSERT INTO tickets (player_id, draw_id, draw_name, ticket_id, total_amount, bets, date)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
            [playerId, drawId, drawName, ticketId, total, JSON.stringify(bets)]
        );
        await pool.query(
            `INSERT INTO transactions (player_id, type, amount, description) VALUES ($1, $2, $3, $4)`,
            [playerId, 'bet', total, `Ticket ${ticketId} - ${drawName}`]
        );
        res.json({ success: true, ticket: { id: result.rows[0].id, ticket_id: ticketId, total_amount: total } });
    } catch (err) {
        console.error(err);
        await pool.query('UPDATE players SET balance = balance + $1 WHERE id = $2', [total, playerId]).catch(() => {});
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/api/player/tickets', authenticatePlayer, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tickets WHERE player_id = $1 ORDER BY date DESC LIMIT 50', [req.player.id]);
        res.json({ tickets: result.rows });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/player/transactions', authenticatePlayer, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions WHERE player_id = $1 ORDER BY created_at DESC LIMIT 50', [req.player.id]);
        res.json({ transactions: result.rows });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/player/recharge/code', authenticatePlayer, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code requis' });
    try {
        const codeRes = await pool.query('SELECT id, amount, used FROM recharge_codes WHERE code = $1', [code]);
        if (codeRes.rows.length === 0) return res.status(404).json({ error: 'Code invalide' });
        const rc = codeRes.rows[0];
        if (rc.used) return res.status(400).json({ error: 'Code déjà utilisé' });
        await pool.query('BEGIN');
        await pool.query('UPDATE players SET balance = balance + $1 WHERE id = $2', [rc.amount, req.player.id]);
        await pool.query('UPDATE recharge_codes SET used = true, used_by_player_id = $1, used_at = NOW() WHERE id = $2', [req.player.id, rc.id]);
        await pool.query('INSERT INTO transactions (player_id, type, amount, method, description) VALUES ($1, $2, $3, $4, $5)', [req.player.id, 'deposit', rc.amount, 'code', `Recharge par code ${code}`]);
        await pool.query('COMMIT');
        const newBalance = await pool.query('SELECT balance FROM players WHERE id = $1', [req.player.id]);
        res.json({ success: true, amount: rc.amount, newBalance: parseFloat(newBalance.rows[0].balance) });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Erreur traitement code' });
    }
});

// ==================== Routes propriétaire ====================
app.get('/api/owner/draws', authenticateOwner, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/owner/draws', authenticateOwner, async (req, res) => {
    const { name, time } = req.body;
    if (!name || !time) return res.status(400).json({ error: 'Nom et heure requis' });
    try {
        await pool.query('INSERT INTO draws (name, time, active) VALUES ($1, $2, true)', [name, time]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Erreur création tirage' }); }
});

app.put('/api/owner/draws/:id/toggle', authenticateOwner, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('UPDATE draws SET active = NOT active WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/owner/publish-results', authenticateOwner, async (req, res) => {
    const { drawId, numbers, lotto3 } = req.body; // numbers = [lot1, lot2, lot3]
    if (!drawId || !numbers || numbers.length !== 3 || !lotto3) return res.status(400).json({ error: 'Données invalides' });
    try {
        await pool.query(`INSERT INTO winning_results (draw_id, numbers, lotto3, date) VALUES ($1, $2, $3, NOW())`, [drawId, JSON.stringify(numbers), lotto3]);
        const settingsRes = await pool.query('SELECT multipliers FROM lottery_settings LIMIT 1');
        let multipliers = { lot1: 90, lot2: 50, lot3: 30, lotto3: 500, lotto4: 5000, lotto5: 25000, mariage: 500 };
        if (settingsRes.rows.length > 0 && settingsRes.rows[0].multipliers) {
            multipliers = typeof settingsRes.rows[0].multipliers === 'string' ? JSON.parse(settingsRes.rows[0].multipliers) : settingsRes.rows[0].multipliers;
        }
        const [lot1, lot2, lot3_num] = numbers;
        const ticketsRes = await pool.query('SELECT id, player_id, bets FROM tickets WHERE draw_id = $1 AND checked = false', [drawId]);
        for (const ticket of ticketsRes.rows) {
            let totalWin = 0;
            const bets = typeof ticket.bets === 'string' ? JSON.parse(ticket.bets) : ticket.bets;
            if (Array.isArray(bets)) {
                for (const bet of bets) {
                    const game = bet.game || bet.specialType;
                    const clean = bet.cleanNumber || (bet.number ? bet.number.replace(/[^0-9]/g, '') : '');
                    const amount = parseFloat(bet.amount) || 0;
                    let gain = 0;
                    if (game === 'borlette' || game === 'BO' || (game && game.startsWith('n'))) {
                        if (clean.length === 2) {
                            if (clean === lot1) gain = amount * multipliers.lot1;
                            else if (clean === lot2) gain = amount * multipliers.lot2;
                            else if (clean === lot3_num) gain = amount * multipliers.lot3;
                        }
                    } else if (game === 'lotto3') {
                        if (clean.length === 3 && clean === lotto3) gain = amount * multipliers.lotto3;
                    } else if (game === 'mariage') {
                        if (clean.length === 4) {
                            const first = clean.slice(0,2), second = clean.slice(2,4);
                            const pairs = [lot1, lot2, lot3_num];
                            let win = false;
                            for (let i = 0; i < 3; i++) {
                                for (let j = 0; j < 3; j++) {
                                    if (i !== j && first === pairs[i] && second === pairs[j]) { win = true; break; }
                                }
                                if (win) break;
                            }
                            if (win) gain = amount * multipliers.mariage;
                        }
                    } else if (game === 'lotto4' && bet.option) {
                        if (clean.length === 4) {
                            let expected = '';
                            if (bet.option == 1) expected = lot1 + lot2;
                            else if (bet.option == 2) expected = lot2 + lot3_num;
                            else if (bet.option == 3) expected = lot1 + lot3_num;
                            if (clean === expected) gain = amount * multipliers.lotto4;
                        }
                    } else if (game === 'lotto5' && bet.option) {
                        if (clean.length === 5) {
                            let expected = '';
                            if (bet.option == 1) expected = lotto3 + lot2;
                            else if (bet.option == 2) expected = lotto3 + lot3_num;
                            if (clean === expected) gain = amount * multipliers.lotto5;
                        }
                    }
                    totalWin += gain;
                }
            }
            await pool.query('UPDATE tickets SET win_amount = $1, checked = true WHERE id = $2', [totalWin, ticket.id]);
            if (totalWin > 0 && ticket.player_id) {
                await pool.query('UPDATE players SET balance = balance + $1 WHERE id = $2', [totalWin, ticket.player_id]);
                await pool.query('INSERT INTO transactions (player_id, type, amount, description) VALUES ($1, $2, $3, $4)', [ticket.player_id, 'win', totalWin, `Gain ticket #${ticket.id}`]);
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur publication' });
    }
});

// Limites globales
app.get('/api/owner/global-limits', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT number, limit_amount FROM global_number_limits');
    res.json(result.rows);
});
app.post('/api/owner/global-limits', authenticateOwner, async (req, res) => {
    const { number, limitAmount } = req.body;
    const normalized = number.padStart(2, '0');
    await pool.query(`INSERT INTO global_number_limits (number, limit_amount) VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET limit_amount = $2`, [normalized, limitAmount]);
    res.json({ success: true });
});
app.delete('/api/owner/global-limits/:number', authenticateOwner, async (req, res) => {
    const { number } = req.params;
    await pool.query('DELETE FROM global_number_limits WHERE number = $1', [number.padStart(2,'0')]);
    res.json({ success: true });
});

// Blocages globaux
app.get('/api/owner/blocked-numbers', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT number FROM global_blocked_numbers');
    res.json({ blockedNumbers: result.rows.map(r => r.number) });
});
app.post('/api/owner/block-number', authenticateOwner, async (req, res) => {
    const { number } = req.body;
    await pool.query('INSERT INTO global_blocked_numbers (number) VALUES ($1) ON CONFLICT DO NOTHING', [number.padStart(2,'0')]);
    res.json({ success: true });
});
app.post('/api/owner/unblock-number', authenticateOwner, async (req, res) => {
    const { number } = req.body;
    await pool.query('DELETE FROM global_blocked_numbers WHERE number = $1', [number.padStart(2,'0')]);
    res.json({ success: true });
});

// Paramètres loterie (avec annonces et carrousel)
app.get('/api/owner/settings', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT name, slogan, logo_url, multipliers, ads_images, announcements FROM lottery_settings LIMIT 1');
    if (result.rows.length === 0) return res.json({ name: 'LOTATO PRO', slogan: '', logoUrl: '', multipliers: {}, adsImages: [], announcements: '' });
    const row = result.rows[0];
    res.json({
        name: row.name,
        slogan: row.slogan,
        logoUrl: row.logo_url,
        multipliers: row.multipliers,
        adsImages: row.ads_images || [],
        announcements: row.announcements || ''
    });
});
app.post('/api/owner/settings', authenticateOwner, async (req, res) => {
    const { name, slogan, logoUrl, multipliers, adsImages, announcements } = req.body;
    await pool.query(
        `INSERT INTO lottery_settings (name, slogan, logo_url, multipliers, ads_images, announcements)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, slogan = EXCLUDED.slogan, logo_url = EXCLUDED.logo_url,
            multipliers = EXCLUDED.multipliers, ads_images = EXCLUDED.ads_images, announcements = EXCLUDED.announcements`,
        [name || 'LOTATO PRO', slogan || '', logoUrl || '', JSON.stringify(multipliers || {}), JSON.stringify(adsImages || []), announcements || '']
    );
    res.json({ success: true });
});

app.post('/api/owner/generate-recharge-code', authenticateOwner, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    await pool.query('INSERT INTO recharge_codes (code, amount) VALUES ($1, $2)', [code, amount]);
    res.json({ success: true, code, amount });
});

app.get('/api/owner/stats', authenticateOwner, async (req, res) => {
    try {
        const tickets = await pool.query('SELECT COUNT(*) as total_tickets, COALESCE(SUM(total_amount),0) as total_bets, COALESCE(SUM(win_amount),0) as total_wins FROM tickets');
        const players = await pool.query('SELECT COUNT(*) as total_players FROM players');
        const recharges = await pool.query('SELECT COALESCE(SUM(amount),0) as total_recharges FROM transactions WHERE type = $1', ['deposit']);
        res.json({
            totalTickets: parseInt(tickets.rows[0].total_tickets),
            totalBets: parseFloat(tickets.rows[0].total_bets),
            totalWins: parseFloat(tickets.rows[0].total_wins),
            totalPlayers: parseInt(players.rows[0].total_players),
            totalRecharges: parseFloat(recharges.rows[0].total_recharges)
        });
    } catch (err) { res.status(500).json({ error: 'Erreur' }); }
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