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

// <-- CAMBIO 1: Guardamos el cuerpo de la petición en formato raw (texto)
// Esto es VITAL para poder verificar la firma del webhook correctamente.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Almacenamiento temporal (Recuerda el riesgo de pérdida de datos en reinicios)
const pendingOrders = new Map();

// --- LÓGICA DE PRECIOS (Sin cambios) ---
// (Tu lógica de precios, updatePrices, etc. va aquí... la omito para ser breve)

// --- ENDPOINTS DE LA API ---

app.get('/get-prices', (req, res) => {
    // Tu lógica actual...
    // res.json(cachedPrices);
});

app.post('/verify-gamepass', async (req, res) => {
    // Tu lógica actual...
});

app.post('/login-with-cookie', async (req, res) => {
    // Tu lógica actual...
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
            // Asegúrate de que esta URL sea accesible públicamente (la de Render, no localhost)
            url_callback: `https://${req.hostname}/payment-notification`
        };

        // <-- CAMBIO 2: Usamos el método de firma del ejemplo para ser consistentes
        // md5(base64(payload) + api_key)
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
    // <-- CAMBIO 3: AÑADIMOS LA VERIFICACIÓN DE FIRMA
    const { sign } = req.body;

    // 1. Verificamos que la notificación tenga una firma
    if (!sign) {
        console.warn("Webhook recibido sin firma.");
        return res.status(400).send("Bad Request: Missing sign");
    }

    try {
        // 2. Preparamos los datos para ser verificados
        // Usamos req.rawBody que guardamos antes.
        const dataToVerify = JSON.parse(req.rawBody);
        delete dataToVerify.sign; // La firma no se incluye en el cálculo de la firma

        // 3. Calculamos nuestra propia firma con la misma lógica
        const calculatedSign = crypto
            .createHash('md5')
            .update(Buffer.from(JSON.stringify(dataToVerify)).toString('base64') + CRYPTOMUS_API_KEY)
            .digest('hex');

        // 4. ¡Comparamos las firmas!
        if (sign !== calculatedSign) {
            console.error("¡ALERTA DE SEGURIDAD! Firma de webhook inválida.");
            return res.status(403).send("Forbidden: Invalid sign"); // Rechazamos la petición
        }

    } catch (error) {
        console.error("Error al procesar la verificación del webhook:", error);
        return res.status(500).send("Internal Server Error");
    }
    // <-- FIN DE LA VERIFICACIÓN DE FIRMA

    // Si llegamos hasta aquí, la notificación es legítima y podemos procesar el pedido.
    const { order_id, status, amount: cryptoAmount, currency: cryptoCurrency } = req.body;
    
    if ((status === 'paid' || status === 'paid_over') && pendingOrders.has(order_id)) {
        const orderData = pendingOrders.get(order_id);
        
        // (Tu lógica actual para enviar la notificación a Telegram va aquí)
        // ...
        
        pendingOrders.delete(order_id);
        console.log(`Orden ${order_id} procesada y notificada de forma segura.`);
    }

    // Le decimos a Cryptomus que todo salió bien.
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor Buxzona escuchando en el puerto ${PORT}`);
    // updatePrices();
});