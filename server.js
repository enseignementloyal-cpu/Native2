// server.js - Authentification unique (owner ou player) - Tirages en base de données
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

// ==================== Base de données (compatible Neon) ====================
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

// ==================== Création des tables ====================
async function initTables() {
    // Propriétaire
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

    // Tirages (gérés entièrement par le propriétaire)
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
            numbers JSONB,
            lotto3 VARCHAR(3),
            date TIMESTAMP DEFAULT NOW()
        )
    `);

    // Tickets
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

    // Transactions
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

    // Codes recharge
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

    // Paramètres loterie
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lottery_settings (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            slogan TEXT,
            logo_url TEXT,
            multipliers JSONB,
            limits JSONB,
            ads_images JSONB,
            announcements TEXT
        )
    `);

    // Limites et blocages
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_number_limits (
            number VARCHAR(2) NOT NULL PRIMARY KEY,
            limit_amount DECIMAL(10,2) NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS draw_number_limits (
            draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
            number VARCHAR(2) NOT NULL,
            limit_amount DECIMAL(10,2) NOT NULL,
            PRIMARY KEY (draw_id, number)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_blocked_numbers (
            number VARCHAR(2) PRIMARY KEY
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS draw_blocked_numbers (
            draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
            number VARCHAR(2) NOT NULL,
            PRIMARY KEY (draw_id, number)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS blocked_lotto3_numbers (
            number VARCHAR(3) PRIMARY KEY
        )
    `);

    // Insertion de quelques tirages par défaut si la table est vide
    const drawsCount = await pool.query('SELECT COUNT(*) FROM draws');
    if (parseInt(drawsCount.rows[0].count) === 0) {
        const defaultDraws = [
            ['Tunisia Matin', '10:00:00', true],
            ['Tunisia Soir', '19:25:00', true],
            ['Florida Matin', '13:30:00', true],
            ['Florida Soir', '21:50:00', true],
            ['New York Matin', '14:30:00', true],
            ['New York Soir', '22:28:00', true],
            ['Georgia Matin', '12:30:00', true],
            ['Georgia Soir', '19:00:00', true],
            ['Texas Matin', '10:55:00', true],
            ['Texas Soir', '18:58:00', true]
        ];
        for (const [name, time, active] of defaultDraws) {
            await pool.query('INSERT INTO draws (name, time, active) VALUES ($1, $2, $3)', [name, time, active]);
        }
        console.log('✅ 10 tirages par défaut créés');
    }

    console.log('✅ Tables créées/vérifiées');
}

// ==================== Cron : fermeture auto des tirages ====================
cron.schedule('* * * * *', async () => {
    try {
        const now = moment().tz('America/Port-au-Prince');
        const currentTime = now.format('HH:mm:ss');
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

// ==================== Routes d'authentification ====================
app.post('/api/auth/player/register', async (req, res) => {
    const { name, phone, password, zone } = req.body;
    if (!name || !phone || !password) {
        return res.status(400).json({ error: 'Nom, téléphone et mot de passe requis' });
    }
    try {
        const existing = await pool.query('SELECT id FROM players WHERE phone = $1', [phone]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Ce numéro est déjà utilisé' });
        }
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
        res.status(500).json({ error: 'Erreur serveur lors de l\'inscription' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }

    // Propriétaire
    const ownerResult = await pool.query('SELECT id, name, username, password FROM owners WHERE username = $1', [identifier]);
    if (ownerResult.rows.length > 0) {
        const owner = ownerResult.rows[0];
        const valid = await bcrypt.compare(password, owner.password);
        if (valid) {
            const token = jwt.sign({ id: owner.id, role: 'owner', name: owner.name }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, token, role: 'owner', name: owner.name });
        }
    }

    // Joueur
    const playerResult = await pool.query('SELECT id, name, phone, password, balance FROM players WHERE phone = $1', [identifier]);
    if (playerResult.rows.length > 0) {
        const player = playerResult.rows[0];
        const valid = await bcrypt.compare(password, player.password);
        if (valid) {
            const token = jwt.sign({ id: player.id, role: 'player', name: player.name, phone: player.phone }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, token, role: 'player', playerId: player.id, name: player.name, balance: parseFloat(player.balance) });
        }
    }

    return res.status(401).json({ error: 'Identifiants incorrects' });
});

// ==================== Routes propriétaire (gestion des tirages) ====================
app.get('/api/owner/draws', authenticateOwner, async (req, res) => {
    const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
    res.json(result.rows);
});

app.post('/api/owner/draws', authenticateOwner, async (req, res) => {
    const { name, time } = req.body;
    if (!name || !time) return res.status(400).json({ error: 'Nom et heure requis' });
    await pool.query('INSERT INTO draws (name, time, active) VALUES ($1, $2, true)', [name, time]);
    res.json({ success: true });
});

app.put('/api/owner/draws/:id/toggle', authenticateOwner, async (req, res) => {
    const { id } = req.params;
    await pool.query('UPDATE draws SET active = NOT active WHERE id = $1', [id]);
    res.json({ success: true });
});

// Routes pour limites, résultats, etc. (inchangées)
app.post('/api/owner/publish-results', authenticateOwner, async (req, res) => { /* ... votre code existant ... */ });
app.get('/api/owner/global-limits', authenticateOwner, async (req, res) => { /* ... */ });
app.post('/api/owner/global-limits', authenticateOwner, async (req, res) => { /* ... */ });
app.delete('/api/owner/global-limits/:number', authenticateOwner, async (req, res) => { /* ... */ });
app.get('/api/owner/blocked-numbers', authenticateOwner, async (req, res) => { /* ... */ });
app.post('/api/owner/block-number', authenticateOwner, async (req, res) => { /* ... */ });
app.post('/api/owner/unblock-number', authenticateOwner, async (req, res) => { /* ... */ });
app.get('/api/owner/settings', authenticateOwner, async (req, res) => { /* ... */ });
app.post('/api/owner/settings', authenticateOwner, async (req, res) => { /* ... */ });
app.post('/api/owner/generate-recharge-code', authenticateOwner, async (req, res) => { /* ... */ });
app.get('/api/owner/stats', authenticateOwner, async (req, res) => { /* ... */ });

// ==================== Routes joueur ====================
app.get('/api/player/balance', authenticatePlayer, async (req, res) => {
    const result = await pool.query('SELECT balance FROM players WHERE id = $1', [req.player.id]);
    res.json({ balance: parseFloat(result.rows[0].balance) });
});

// Route GET /api/draws (utilisée par player.html) – renvoie les tirages depuis la base
app.get('/api/draws', authenticatePlayer, async (req, res) => {
    const result = await pool.query('SELECT id, name, time, active FROM draws ORDER BY time');
    res.json({ draws: result.rows });
});

app.get('/api/player/limits', authenticatePlayer, async (req, res) => { /* ... */ });
app.get('/api/player/settings', authenticatePlayer, async (req, res) => { /* ... */ });
app.post('/api/player/tickets/save', authenticatePlayer, async (req, res) => { /* ... */ });
app.get('/api/player/tickets', authenticatePlayer, async (req, res) => { /* ... */ });
app.get('/api/player/transactions', authenticatePlayer, async (req, res) => { /* ... */ });
app.post('/api/player/recharge/code', authenticatePlayer, async (req, res) => { /* ... */ });

// Route pour les résultats gagnants (utilisée par player.html)
app.get('/api/winners/results', authenticatePlayer, async (req, res) => {
    const results = await pool.query(`
        SELECT w.*, d.name FROM winning_results w
        JOIN draws d ON w.draw_id = d.id
        ORDER BY w.date DESC LIMIT 50
    `);
    res.json({ results: results.rows });
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