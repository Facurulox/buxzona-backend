// 1. Importamos las herramientas
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const crypto = require('crypto');

// 2. Configuraciones y Secretos
const PORT = process.env.PORT || 3000;
const PROFIT_MARGIN_USD = 1.70;
const ROBUX_AMOUNT_TO_PRICE = 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRYPTOMUS_API_KEY = process.env.CRYPTOMUS_API_KEY;
const CRYPTOMUS_MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID;

const app = express();
app.use(cors());

// Guardamos el cuerpo de la petición en formato raw para verificar la firma del webhook
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Almacenamiento temporal (Recuerda el riesgo de pérdida de datos en reinicios)
const pendingOrders = new Map();

// --- (Aquí iría tu lógica para obtener precios, la omito para ser breve) ---

// --- ENDPOINTS DE LA API ---

app.get('/get-prices', (req, res) => {
    // Tu lógica actual para devolver precios...
    // Ejemplo de respuesta con precios de respaldo:
    res.json({
        usd: { rate: 0.0043, symbol: '$', min: 2.0, max: 180.0 },
        rub: { rate: 0.344, symbol: '₽', min: 160, max: 14400 }
    });
});

app.post('/login-with-cookie', async (req, res) => {
    const { cookie } = req.body;
    if (!cookie) return res.status(400).json({ error: 'Cookie no proporcionada.' });

    try {
        const userResponse = await axios.get('https://users.roblox.com/v1/users/authenticated', {
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}` }
        });
        const userData = userResponse.data;
        if (!userData.id) return res.status(401).json({ error: 'Cookie inválida o expirada.' });

        const avatarResponse = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userData.id}&size=150x150&format=Png&isCircular=false`);
        const avatarUrl = avatarResponse.data.data[0].imageUrl;

        res.json({ id: userData.id, name: userData.name, avatarUrl });
    } catch (error) {
        console.error('Error en login con cookie:', error.message);
        res.status(401).json({ error: 'Cookie inválida o expirada.' });
    }
});


// --- ENDPOINT DE VERIFICACIÓN MODIFICADO PARA PRUEBAS ---
app.post('/verify-gamepass', async (req, res) => {
    // ¡ADVERTENCIA! Este cambio es solo para pruebas.
    // La verificación real está desactivada y siempre se asume que es exitosa.
    console.log("ADVERTENCIA: Saltando la verificación real del Game Pass para pruebas.");
    return res.json({ success: true });

    /*
    // LÓGICA ORIGINAL (DESACTIVADA TEMPORALMENTE)
    const { gamepassUrl, expectedRobux } = req.body;
    // ... (todo el código de verificación que comentamos)
    */
});


app.post('/create-payment', async (req, res) => {
    if (!CRYPTOMUS_API_KEY || !CRYPTOMUS_MERCHANT_ID) {
        return res.status(500).json({ error: "El sistema de pagos no está configurado." });
    }
    try {
        const { currencyAmount, currency, ...orderData } = req.body;
        const orderId = crypto.randomUUID();

        pendingOrders.set(orderId, orderData);

        const payload = {
            amount: currencyAmount.toString(),
            currency: currency.toUpperCase(),
            order_id: orderId,
            url_callback: `https://${req.hostname}/payment-notification`
        };

        const sign = crypto
            .createHash('md5')
            .update(Buffer.from(JSON.stringify(payload)).toString('base64') + CRYPTOMUS_API_KEY)
            .digest('hex');
        
        const response = await axios.post('https://api.cryptomus.com/v1/payment', payload, {
            headers: {
                'merchant': CRYPTOMUS_MERCHANT_ID,
                'sign': sign,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.result) {
            res.json({ paymentUrl: response.data.result.url });
        } else {
            throw new Error('Cryptomus API no devolvió un resultado exitoso.');
        }
    } catch (error) {
        console.error('Error al crear pago en Cryptomus:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'No se pudo crear el link de pago.' });
    }
});


// --- WEBHOOK SEGURO ---
app.post('/payment-notification', (req, res) => {
    const { sign } = req.body;
    if (!sign) {
        console.warn("Webhook recibido sin firma.");
        return res.status(400).send("Bad Request: Missing sign");
    }

    try {
        const dataToVerify = JSON.parse(req.rawBody);
        delete dataToVerify.sign;

        const calculatedSign = crypto
            .createHash('md5')
            .update(Buffer.from(JSON.stringify(dataToVerify)).toString('base64') + CRYPTOMUS_API_KEY)
            .digest('hex');

        if (sign !== calculatedSign) {
            console.error("¡ALERTA DE SEGURIDAD! Firma de webhook inválida.");
            return res.status(403).send("Forbidden: Invalid sign");
        }
    } catch (error) {
        console.error("Error al procesar la verificación del webhook:", error);
        return res.status(500).send("Internal Server Error");
    }

    const { order_id, status } = req.body;
    if ((status === 'paid' || status === 'paid_over') && pendingOrders.has(order_id)) {
        console.log(`Orden ${order_id} pagada. Procesando notificación...`);
        // (Tu lógica para enviar la notificación a Telegram va aquí)
        pendingOrders.delete(order_id);
    }
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor Buxzona escuchando en el puerto ${PORT}`);
});