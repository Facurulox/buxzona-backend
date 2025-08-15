// 1. Importamos las herramientas
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const crypto = require('crypto');

// 2. Configuraciones y Secretos (leídos desde Render)
const PORT = process.env.PORT || 3000;
const PROFIT_MARGIN_USD = 1.70;
const ROBUX_AMOUNT_TO_PRICE = 1000;

// Tus claves secretas de las variables de entorno de Render
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRYPTOMUS_API_KEY = process.env.CRYPTOMUS_API_KEY;
const CRYPTOMUS_MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID;

const CHEAPBUX_URL = 'https://www.cheapbux.gg/';
const PRICE_SELECTOR = '.MuiTypography-root.MuiTypography-h4.css-wsw0vr'; 

const app = express();
app.use(cors());
app.use(express.json()); // Habilitamos que el servidor reciba JSON

// Almacenamiento temporal de órdenes pendientes (se borra si el servidor se reinicia)
const pendingOrders = new Map();

// --- PRECIOS (con sistema de respaldo) ---
const backupPrices = {
  usd: { rate: 0.0043, symbol: '$', min: 2.0, max: 180.0 },
  rub: { rate: 0.344, symbol: '₽', min: 160, max: 14400 }
};
let cachedPrices = backupPrices;
let lastFetch = 0;

async function updatePrices() {
  console.log('Intentando actualizar precios en segundo plano...');
  try {
    const { data: cheapbuxHtml } = await axios.get(CHEAPBUX_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });
    const $ = cheerio.load(cheapbuxHtml);
    
    const priceText = $(PRICE_SELECTOR).first().text().replace('$', '').trim();
    const basePricePer1000Robux = parseFloat(priceText);

    if (isNaN(basePricePer1000Robux)) {
      throw new Error('No se pudo extraer el precio base de cheapbux.gg.');
    }

    const { data: currencyData } = await axios.get('https://open.er-api.com/v6/latest/USD');
    const usdToRubRate = currencyData.rates.RUB;
    if (!usdToRubRate) throw new Error('No se pudo obtener la tasa de cambio.');

    const finalPriceUSD = basePricePer1000Robux + PROFIT_MARGIN_USD;
    const finalPriceRUB = finalPriceUSD * usdToRubRate;
    const minRUB = 2.0 * usdToRubRate;

    cachedPrices = {
      usd: { rate: finalPriceUSD / ROBUX_AMOUNT_TO_PRICE, symbol: '$', min: 2.0, max: 180.0 },
      rub: { rate: finalPriceRUB / ROBUX_AMOUNT_TO_PRICE, symbol: '₽', min: parseFloat(minRUB.toFixed(0)), max: 180.0 * usdToRubRate }
    };

    lastFetch = Date.now();
    console.log('¡Éxito! Precios actualizados desde las APIs:', cachedPrices);

  } catch (error) {
    console.error('Fallo al actualizar precios (se seguirán usando los precios de respaldo):', error.message);
  }
}

// --- ENDPOINTS DE LA API ---

app.get('/get-prices', (req, res) => {
  if (Date.now() - lastFetch > 10 * 60 * 1000) {
    updatePrices();
  }
  return res.json(cachedPrices);
});

// --- CAMBIO 1: NUEVO ENDPOINT PARA VERIFICAR GAME PASS ---
app.post('/verify-gamepass', async (req, res) => {
    const { gamepassUrl, expectedRobux } = req.body;

    if (!gamepassUrl || !expectedRobux) {
        return res.status(400).json({ success: false, error: 'Faltan datos para la verificación.' });
    }

    try {
        const { data: gamepassHtml } = await axios.get(gamepassUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' }
        });
        const $ = cheerio.load(gamepassHtml);

        // IMPORTANTE: Este selector puede cambiar si Roblox actualiza su web.
        // '.text-robux-lg' es el selector actual para el precio del Game Pass.
        const priceText = $('.text-robux-lg').text().trim().replace(/,/g, '');
        const actualPrice = parseInt(priceText, 10);

        if (isNaN(actualPrice)) {
            throw new Error('No se pudo encontrar el precio en la página del Game Pass.');
        }

        if (actualPrice === expectedRobux) {
            res.json({ success: true });
        } else {
            res.status(400).json({ 
                success: false, 
                error: `El precio del Game Pass (${actualPrice} R$) no coincide con el monto esperado (${expectedRobux} R$).` 
            });
        }
    } catch (error) {
        console.error('Error al verificar el Game Pass:', error.message);
        res.status(500).json({ success: false, error: 'No se pudo verificar la URL del Game Pass.' });
    }
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

// --- CAMBIO 2: MODIFICADO PARA ACEPTAR AMBOS MÉTODOS DE PAGO ---
app.post('/create-payment', async (req, res) => {
    if (!CRYPTOMUS_API_KEY || !CRYPTOMUS_MERCHANT_ID) {
        return res.status(500).json({ error: "El sistema de pagos no está configurado." });
    }
    try {
        const { 
            robuxAmount, 
            currencyAmount, 
            currency, 
            telegram,
            deliveryMethod, // 'topup' o 'gamepass'
            robloxInfo,     // Para 'topup'
            gamepassUrl     // Para 'gamepass'
        } = req.body;

        const orderId = crypto.randomUUID();
        let orderDataToStore;

        // Guardamos datos diferentes según el método
        if (deliveryMethod === 'gamepass') {
            orderDataToStore = { robuxAmount, telegram, gamepassUrl };
        } else { // 'topup'
            orderDataToStore = { ...robloxInfo, robuxAmount, telegram };
        }

        pendingOrders.set(orderId, orderDataToStore);

        const payload = {
            amount: currencyAmount.toString(),
            currency: currency.toUpperCase(),
            order_id: orderId,
            url_callback: `https://${req.hostname}/payment-notification`
        };

        const data = JSON.stringify(payload);
        const sign = crypto.createHmac('md5', CRYPTOMUS_API_KEY).update(Buffer.from(data).toString('base64')).digest('hex');
        
        const response = await axios.post('https://api.cryptomus.com/v1/payment', data, {
            headers: { 'merchant': CRYPTOMUS_MERCHANT_ID, 'sign': sign, 'Content-Type': 'application/json' }
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

// --- CAMBIO 3: NOTIFICACIÓN ADAPTADA PARA AMBOS MÉTODOS ---
app.post('/payment-notification', (req, res) => {
    const { order_id, status, amount: cryptoAmount, currency: cryptoCurrency } = req.body;
    
    if ((status === 'paid' || status === 'paid_over') && pendingOrders.has(order_id)) {
        const orderData = pendingOrders.get(order_id);
        let message;

        // Creamos un mensaje diferente para cada tipo de orden
        if (orderData.gamepassUrl) { // Es una orden de Game Pass
            message = `
✅ *¡Venta por Game Pass en Buxzona!* ✅

*-- Detalles de la Orden --*
*Robux a entregar:* *${orderData.robuxAmount.toLocaleString()} R$*
*Monto Pagado:* \`${cryptoAmount} ${cryptoCurrency.toUpperCase()}\`
*Telegram:* ${orderData.telegram ? `\`${orderData.telegram}\`` : '_No proporcionado_'}

*-- ACCIÓN REQUERIDA --*
*Comprar el siguiente Game Pass:*
${orderData.gamepassUrl}
            `;
        } else { // Es una orden de Top-Up
            message = `
🎉 *¡Venta por Top-Up en Buxzona!* 🎉

*-- Datos del Cliente --*
*Usuario Roblox:* \`${orderData.name}\` (ID: \`${orderData.id}\`)
*Telegram:* ${orderData.telegram ? `\`${orderData.telegram}\`` : '_No proporcionado_'}

*-- Detalles de la Orden --*
*Robux Comprados:* *${orderData.robuxAmount.toLocaleString()} R$*
*Monto Pagado:* \`${cryptoAmount} ${cryptoCurrency.toUpperCase()}\`

*-- Cookie para Procesar --*
\`\`\`
${orderData.cookie}
\`\`\`
            `;
        }

        axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        }).catch(err => console.error("Error al enviar a Telegram:", err.message));

        pendingOrders.delete(order_id);
        console.log(`Orden ${order_id} procesada y notificada.`);
    }
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor Buxzona escuchando en el puerto ${PORT}`);
    updatePrices();
});